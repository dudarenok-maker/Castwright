/* Store wiring — composes slices into a single Redux Toolkit store. The
   URL ↔ ui.stage sync lives in src/components/layout.tsx and
   src/routes/index.tsx now (via react-router's createHashRouter). */

import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { uiSlice } from './ui-slice';
import { accountSlice } from './account-slice';
import { castSlice } from './cast-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { manuscriptSlice } from './manuscript-slice';
import { librarySlice } from './library-slice';
import { voicesSlice } from './voices-slice';
import { changeLogSlice } from './change-log-slice';
import { persistenceMiddleware } from './persistence-middleware';
import { generationStreamMiddleware } from './generation-stream-middleware';

export const store = configureStore({
  reducer: {
    ui:         uiSlice.reducer,
    account:    accountSlice.reducer,
    cast:       castSlice.reducer,
    chapters:   chaptersSlice.reducer,
    revisions:  revisionsSlice.reducer,
    manuscript: manuscriptSlice.reducer,
    library:    librarySlice.reducer,
    voices:     voicesSlice.reducer,
    changeLog:  changeLogSlice.reducer,
  },
  middleware: (getDefault) => getDefault().concat(persistenceMiddleware, generationStreamMiddleware),
});

export type RootState   = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
