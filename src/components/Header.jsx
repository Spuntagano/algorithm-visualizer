/** Title, language and example pickers, and a link to the source on GitHub. */
import { LangInfo } from './LangInfo.jsx';

export const REPO_URL = 'https://github.com/Spuntagano/algorithm-visualizer';
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
      <a className="gh-link" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="Source on GitHub" aria-label="Source on GitHub">
        <svg viewBox="0 0 16 16" aria-hidden="true">{/* GitHub's mark (Octicons, MIT) */}
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
        </svg>
      </a>
    </header>
  );
}
