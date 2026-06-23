import { javascript } from '@codemirror/lang-javascript';
import CodeMirror from '@uiw/react-codemirror';

import { useTheme } from '../../lib/theme/ThemeProvider';

/**
 * A CodeMirror 6 JavaScript editor (syntax highlight, line numbers, bracket
 * matching, autocomplete). Used for the provider-plugin sandbox handler — far
 * better than a `<textarea>` for editing the mapRequest/mapResponse code. The
 * editor theme follows the console's light/dark setting.
 */
export function CodeEditor({
  value,
  onChange,
  minHeight = '280px',
  ariaLabel,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: string;
  ariaLabel?: string;
  readOnly?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        border: '1px solid var(--panel-bd)',
        borderRadius: 'var(--r-sm)',
        overflow: 'hidden',
        fontSize: 'var(--fs-sm)',
      }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={theme === 'dark' ? 'dark' : 'light'}
        extensions={[javascript()]}
        minHeight={minHeight}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
        }}
      />
    </div>
  );
}
