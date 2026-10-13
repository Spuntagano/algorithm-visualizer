/** Title, example picker and the Visualize / Edit code button. */
export function Header({ examples, example, onExample, editing, busy, onRun, onEdit }) {
  return (
    <header className="site-header">
      <div>
        <h1>Step through an algorithm</h1>
        <p>Run JavaScript one statement at a time and watch arrays, objects, Maps and Sets change.</p>
      </div>
      <div className="actions">
        <label className="sel">Example
          <select id="example" aria-label="Choose an example" value={example} onChange={e => onExample(e.target.value)}>
            {examples.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {editing
          ? <button className="btn primary" id="btnRun" disabled={busy} onClick={onRun}>{busy ? 'Running…' : 'Visualize'}</button>
          : <button className="btn" id="btnEdit" onClick={onEdit}>Edit code</button>}
      </div>
    </header>
  );
}
