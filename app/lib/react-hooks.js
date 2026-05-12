/* React hook globals — installed once so each module file can reference
   useState/useEffect/etc. without redeclaring them. */
window.useState    = React.useState;
window.useEffect   = React.useEffect;
window.useRef      = React.useRef;
window.useMemo     = React.useMemo;
window.useCallback = React.useCallback;
