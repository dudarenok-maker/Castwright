/* Store wiring — composes slices into a single Redux Toolkit store and
   exposes the Provider + selector/dispatch hooks as globals. */
const store = RTK.configureStore({
  reducer: {
    ui:         uiSlice.reducer,
    cast:       castSlice.reducer,
    chapters:   chaptersSlice.reducer,
    revisions:  revisionsSlice.reducer,
    manuscript: manuscriptSlice.reducer,
  },
});
window.store = store;
window.Provider     = ReactRedux.Provider;
window.useSelector  = ReactRedux.useSelector;
window.useDispatch  = ReactRedux.useDispatch;

/* Boot the hash router — defined in lib/router.js, loaded right after this. */
if (typeof installRouter === 'function') installRouter(store);
