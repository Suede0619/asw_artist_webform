import React from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './Application.jsx';
import { Callback, Landing, Privacy, Resume, Start } from './PublicPages.jsx';
import { ReviewDesk } from './ReviewDesk.jsx';
import { Layout } from './ui.jsx';
import './styles.css';

const pages = {
  '/': [Landing, 'Artist invitation'],
  '/start': [Start, 'Start or resume a submission'],
  '/resume': [Resume, 'Open your submission'],
  '/apply': [Application, 'Artist submission'],
  '/callback': [Callback, 'Request a call'],
  '/review': [ReviewDesk, 'Staff review'],
  '/privacy': [Privacy, 'Privacy and submissions'],
};
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const [Page, title] = pages[path] || pages['/'];
document.title = title + ' | Southwest Arts';
createRoot(document.getElementById('root')).render(<Layout review={path === '/review'}><Page /></Layout>);
