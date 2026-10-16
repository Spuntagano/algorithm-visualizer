/** Title, language and example pickers. */
export function Header({ examples, example, onExample, lang, langs, onLang }) {
  return (
    <header className="site-header">
      <div>
        <h1>Step through an algorithm</h1>
        <p>Run {langs[lang]} one statement at a time and watch {lang === 'python' ? 'lists, dicts, sets and objects' : lang === 'lua' ? 'tables' : lang === 'ruby' ? 'arrays, hashes, sets and objects' : lang === 'c' ? 'arrays, structs, pointers and memory' : lang === 'cpp' ? 'vectors, maps, objects and pointers' : lang === 'java' ? 'arrays, lists, maps and objects' : lang === 'go' ? 'slices, maps, structs and pointers' : lang === 'csharp' ? 'arrays, lists, dictionaries and objects' : lang === 'kotlin' ? 'lists, maps, sets and objects' : lang === 'php' ? 'arrays and objects' : 'arrays, objects, Maps and Sets'} change.</p>
      </div>
      <div className="actions">
        <label className="sel">Language
          <select id="lang" aria-label="Choose a language" value={lang} onChange={e => onLang(e.target.value)}>
            {Object.entries(langs).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="sel">Example
          <select id="example" aria-label="Choose an example" value={example} onChange={e => onExample(e.target.value)}>
            <option value="" disabled>Choose an example…</option>
            {examples.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
    </header>
  );
}
