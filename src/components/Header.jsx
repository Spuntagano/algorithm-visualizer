/** Title, language and example pickers. */
import { LangInfo } from './LangInfo.jsx';

export const SUBTITLE = 'Visualize any algorithm by stepping through your code one statement at a time.';

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
          <h1>Algorithm visualizer</h1>
          <p title={SUBTITLE}>{SUBTITLE}</p>
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
