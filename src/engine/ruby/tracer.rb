# The Ruby tracer: runs the program once under a TracePoint and records a snapshot before every line, in the same
# format as the JavaScript tracer (see src/model.js), so every view works unchanged. Runs inside ruby.wasm
# (src/engine/worker.js), in a fresh VM per run; RubyTracer.trace_json(source) returns the recording as JSON text.
require "json"
require "set"
require "stringio"
require "prism"

module RubyTracer
  MAX_STEPS = 3000   # stop runaway loops
  MAX_CALLS = 300    # stop runaway recursion
  MAX_DEPTH = 5      # how deeply nested values are expanded
  MAX_ITEMS = 60     # array / set elements kept per container
  MAX_KEYS = 30      # hash / object entries kept per container
  FILE = "(code)"

  # Ends a run early (step or call limit) without it counting as a program error. Not a StandardError, so the
  # program's own `rescue => e` cannot swallow it.
  class StopRun < Exception; end

  # $stdout while the program runs: every finished line becomes one entry of the Output panel
  class Out < StringIO
    def initialize(logs) = (super(); @logs = logs; @line = +"")
    def write(*parts)
      parts.each { |p| @line << p.to_s }
      while (i = @line.index("\n"))
        @logs << { type: "log", s: @line[0...i] }
        @line = @line[(i + 1)..]
      end
      parts.sum { |p| p.to_s.bytesize }
    end
    def finish = (@logs << { type: "log", s: @line } unless @line.empty?)
  end

  def self.clip(s, n) = s.length > n ? s[0, n] + "…" : s
  def self.prim(k, s) = { t: "p", k: k, s: s }

  # Short one-line preview, for call-stack arguments.
  def self.brief(v)
    case v
    when String then JSON.generate(clip(v, 14))
    when Array then "[" + v.first(6).map { |x| x.is_a?(Array) || x.is_a?(Hash) ? "…" : brief(x) }.join(", ") + (v.size > 6 ? ", …" : "") + "]"
    when Hash then "{…}"
    when nil, true, false, Numeric, Symbol then v.inspect
    else "#<#{v.class}>"
    end
  end

  # Turns live values into snapshot nodes. Object ids are stable for the whole run (#3 is always the same object).
  class Serializer
    def initialize = (@ids = {}.compare_by_identity)
    def id_of(o) = (@ids[o] ||= @ids.size + 1)

    def ser(v, ctx, depth)
      case v
      when nil then return RubyTracer.prim("null", "nil")
      when true, false then return RubyTracer.prim("bool", v.to_s)
      when Integer, Float then return RubyTracer.prim("num", v.to_s)
      when Numeric then return RubyTracer.prim("num", v.inspect)
      when String then return RubyTracer.prim("str", JSON.generate(RubyTracer.clip(v, 80)))
      when Symbol then return RubyTracer.prim("sym", ":" + v.to_s)     # :b names the node "b" (model.js keyOf)
      when Proc, Method, UnboundMethod, Module then return { t: "fn", s: v.respond_to?(:name) && v.name ? v.name.to_s : "proc" }
      when Range then return RubyTracer.prim("str", JSON.generate(v.inspect))
      end
      id = id_of(v)
      if ctx[:seen].include?(id)
        ctx[:refs] << id
        return { t: "ref", id: id }
      end
      ctx[:seen] << id
      return { t: "trunc", id: id } if depth >= MAX_DEPTH
      kid = ->(x) { ser(x, ctx, depth + 1) }
      case v
      when Array
        n = [v.size, MAX_ITEMS].min
        { t: "arr", id: id, len: v.size, items: v.first(n).map(&kid), more: v.size - n, cls: v.class.name }
      when Set
        items = v.to_a
        n = [items.size, MAX_ITEMS].min
        { t: "set", id: id, items: items.first(n).map(&kid), more: items.size - n, cls: "Set" }
      when Hash
        pairs = v.first(MAX_KEYS)
        names = v.keys.map { |k| k.is_a?(String) || k.is_a?(Symbol) ? k.to_s : nil }
        if names.none?(&:nil?) && names.uniq.size == names.size   # keys are names, as in a JavaScript object
          { t: "obj", id: id, cls: "", tn: "Hash", entries: pairs.map { |k, x| [k.to_s, kid.(x)] }, more: v.size - pairs.size }
        else
          { t: "map", id: id, entries: pairs.map { |k, x| [kid.(k), kid.(x)] }, more: v.size - pairs.size, cls: "Hash" }
        end
      when Struct
        members = v.members.first(MAX_KEYS)
        { t: "obj", id: id, cls: v.class.name || "Struct", entries: members.map { |m| [m.to_s, kid.(v[m])] }, more: v.members.size - members.size }
      else
        ivars = v.instance_variables
        if ivars.empty?
          RubyTracer.prim("str", JSON.generate(RubyTracer.clip(v.inspect, 80)))
        else                                                        # an object of a class: its instance variables, without the @
          kept = ivars.first(MAX_KEYS)
          { t: "obj", id: id, cls: v.class.name.to_s, entries: kept.map { |iv| [iv.to_s.delete_prefix("@"), kid.(v.instance_variable_get(iv))] },
            more: ivars.size - kept.size }
        end
      end
    rescue StandardError
      RubyTracer.prim("str", JSON.generate("[unreadable]"))
    end

    # named: [[name, value, scope]] → [vars, refs]; locals first, like the JavaScript tracer
    def capture(named)
      ctx = { seen: Set.new, refs: Set.new }
      vars = named.sort_by.with_index { |(_, _, sc), i| [sc == "local" ? 0 : 1, i] }.map { |n, v, sc| { name: n, scope: sc, node: ser(v, ctx, 0) } }
      [vars, ctx[:refs].to_a.sort]
    end
  end

  # Variables worth showing: not functions or classes (like the JavaScript tracer skipping functions).
  def self.shown?(v) = !(v.is_a?(Proc) || v.is_a?(Method) || v.is_a?(Module))

  # Ruby reserves every local of a scope when it parses it, so a variable reads nil before its first assignment.
  # The line where each name is first assigned (or bound as a parameter), so it is only shown once that line has run.
  def self.first_writes(src)
    lines = {}
    walk = lambda do |node|
      return unless node
      kind = node.class.name.to_s
      if node.respond_to?(:name) && node.name && (kind.include?("LocalVariable") || kind.include?("ParameterNode"))
        n = node.name.to_s
        l = node.location.start_line
        lines[n] = l if !lines[n] || l < lines[n]
      end
      node.compact_child_nodes.each { |c| walk.(c) }
    end
    walk.(Prism.parse(src).value)
    lines
  end

  def self.trace(src)
    steps, logs, stack = [], [], []
    ser = Serializer.new
    top = TOPLEVEL_BINDING
    main = top.receiver
    base_globals = global_variables
    base_consts = Object.constants
    stopped = nil
    busy = false                                                    # while taking a snapshot (it must not be traced itself)

    written = first_writes(src)
    # assigned yet? its first assignment is on an earlier line (or the program is over), or it holds a value already
    assigned = ->(n, v, line) { !v.nil? || line < 0 || (written[n] && written[n] < line) }

    snapshot = lambda do |bind, line, method|
      named = []
      if bind && method                                               # inside a method: its locals, and self if it is an object
        bind.local_variables.each { |n| v = bind.local_variable_get(n); named << [n.to_s, v, "local"] if shown?(v) && assigned.(n.to_s, v, line) }
        me = bind.receiver
        named << ["self", me, "local"] unless me.equal?(main) || me.is_a?(Module)
      end
      seen = named.map(&:first)
      scope_vars = bind && !method ? bind : top                       # at the top level (or in a top-level block): those locals
      scope_vars.local_variables.each do |n|
        next if seen.include?(n.to_s)
        v = scope_vars.local_variable_get(n)
        named << [n.to_s, v, "global"] if shown?(v) && assigned.(n.to_s, v, line)
      end
      (global_variables - base_globals).each { |g| v = eval(g.to_s); named << [g.to_s, v, "global"] if shown?(v) }
      (Object.constants - base_consts).each { |c| v = Object.const_get(c); named << [c.to_s, v, "global"] if shown?(v) }
      vars, refs = ser.capture(named)
      steps << { line: line, stack: stack.map(&:dup), vars: vars, refs: refs, logs: logs.size }
    end

    tp = TracePoint.new(:line, :call, :return) do |t|
      next if busy || t.path != FILE
      if stopped
        raise StopRun, stopped if t.event == :line                     # keep stopping, even if the program rescues Exception
        next
      end
      case t.event
      when :call
        b = t.binding
        args = t.parameters.map { |_, n| n && b.local_variable_defined?(n) ? "#{n}=#{brief(b.local_variable_get(n))}" : nil }.compact.join(", ")
        me = b.receiver
        name = me.equal?(main) ? t.method_id.to_s : "#{me.is_a?(Module) ? me : me.class}#{me.is_a?(Module) ? '.' : '#'}#{t.method_id}"
        stack << { name: name, args: clip(args, 70) }
        raise StopRun, (stopped = "Trace stopped: more than #{MAX_CALLS} nested calls.") if stack.size > MAX_CALLS
      when :return
        stack.pop
      when :line
        raise StopRun, (stopped = "Trace stopped after #{MAX_STEPS} steps (possible infinite loop).") if steps.size >= MAX_STEPS
        busy = true
        begin
          snapshot.(t.binding, t.lineno, t.method_id)
        ensure
          busy = false
        end
      end
    end

    error = nil
    out = Out.new(logs)
    saved = $stdout
    $stdout = out
    begin
      tp.enable { eval(src, top, FILE, 1) }
    rescue StopRun => e
      error = { msg: e.message, soft: true }
    rescue SyntaxError
      raise
    rescue Exception => e                                           # the program's own error
      error = { msg: "#{e.class}: #{e.message}" }
    ensure
      tp.disable
      $stdout = saved
      out.finish
    end
    stack.clear
    busy = true
    snapshot.(nil, -1, nil)                                           # the end: what is left at the top level
    { steps: steps, logs: logs, error: error }
  end

  # "(code):1: syntax errors found\n> 1 | x = = 1\n    |   ^ expected an expression…" → "line 1: expected an expression…"
  def self.syntax_message(e)
    text = e.message
    line = text[/\(code\):(\d+)/, 1]
    first = text[/\^+ ([^\n]+)/, 1] || text.lines.first.to_s.sub(/\A\(code\):\d+:\s*/, "").strip
    line ? "line #{line}: #{first}" : first
  end

  def self.trace_json(src)
    JSON.generate(trace(src))
  rescue SyntaxError => e
    JSON.generate({ syntax: syntax_message(e) })
  end
end
