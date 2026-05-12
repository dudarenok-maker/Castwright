/* Store wiring — composes slices into a single Redux Toolkit store and
   wires the hash router via the RouterStore adapter from lib/router. */

import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { uiSlice, uiActions } from './ui-slice';
import { castSlice } from './cast-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { manuscriptSlice } from './manuscript-slice';
import { librarySlice } from './library-slice';
import { voicesSlice } from './voices-slice';
import { persistenceMiddleware } from './persistence-middleware';
import { installRouter, type RouterStore } from '../lib/router';

export const store = configureStore({
  reducer: {
    ui:         uiSlice.reducer,
    cast:       castSlice.reducer,
    chapters:   chaptersSlice.reducer,
    revisions:  revisionsSlice.reducer,
    manuscript: manuscriptSlice.reducer,
    library:    librarySlice.reducer,
    voices:     voicesSlice.reducer,
  },
  middleware: (getDefault) => getDefault().concat(persistenceMiddleware),
});

export type RootState   = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

/* Two-way URL ↔ stage binding. */
const routerStore: RouterStore = {
  getStage: () => store.getState().ui.stage,
  hydrate:  (stage) => { store.dispatch(uiActions.hydrateFromUrl(stage)); },
  subscribe: (cb) => store.subscribe(cb),
};
installRouter(routerStore);
