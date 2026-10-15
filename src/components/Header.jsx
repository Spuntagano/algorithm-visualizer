/** Title and example picker. */
export function Header({ examples, example, onExample }) {
  return (
    <header className="site-header">
      <div>
        <h1>Step through an algorithm</h1>
        <p>Run JavaScript one statement at a time and watch arrays, objects, Maps and Sets change.</p>
      </div>
      <div className="actions">
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
