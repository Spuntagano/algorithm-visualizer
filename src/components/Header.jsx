/** Title, language and example pickers. */
import { LangInfo } from './LangInfo.jsx';

export function Header({ examples, example, onExample, lang, langs, onLang }) {
  return (
    <header className="site-header">
      <div className="brand">
        <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" />
          <path d="M8 22h5v-5h5v-5h6" />
          <circle cx="24" cy="12" r="2.4" />
        </svg>
        <div>
          <h1>Step through an algorithm</h1>
          <p>Run your code one statement at a time and watch {lang === 'python' ? 'lists, dicts, sets and objects' : lang === 'lua' ? 'tables' : lang === 'ruby' ? 'arrays, hashes, sets and objects' : lang === 'c' ? 'arrays, structs, pointers and memory' : lang === 'cpp' ? 'vectors, maps, objects and pointers' : lang === 'java' ? 'arrays, lists, maps and objects' : lang === 'go' ? 'slices, maps, structs and pointers' : lang === 'csharp' ? 'arrays, lists, dictionaries and objects' : lang === 'kotlin' ? 'lists, maps, sets and objects' : lang === 'swift' ? 'arrays, dictionaries, structs and classes' : lang === 'php' ? 'arrays and objects' : 'arrays, objects, Maps and Sets'} change.</p>
        </div>
      </div>
      <div className="actions">
        <div className="field">
          <label className="sel">Language
            <select id="lang" aria-label="Choose a language" value={lang} onChange={e => onLang(e.target.value)}>
              {Object.entries(langs).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <LangInfo lang={lang} name={langs[lang]} />
        </div>
        <div className="field">
          <label className="sel">Example
            <select id="example" aria-label="Choose an example" value={example} onChange={e => onExample(e.target.value)}>
              <option value="" disabled>Choose an example…</option>
              {examples.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        </div>
      </div>
    </header>
  );
}
