import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router-dom';
import { store } from './store';
import { router } from './routes';
import { ErrorBoundary } from './components/error-boundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Provider store={store}><RouterProvider router={router}/></Provider>
  </ErrorBoundary>
);
