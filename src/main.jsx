import React from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './Application.jsx';
import { Callback, Landing, Privacy, Resume } from './PublicPages.jsx';
import { ReviewDesk } from './ReviewDesk.jsx';
import { Layout } from './ui.jsx';
import './styles.css';

const pages = {
  '/': [Landing, 'Artist invitation'],
  '/resume': [Resume, 'Open your submission'],
  '/apply': [Application, 'Artist submission'],
  '/callback': [Callback, 'Request a call'],
  '/review': [ReviewDesk, 'Staff review'],
  '/privacy': [Privacy, 'Privacy'],
};
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const [Page, title] = pages[path] || pages['/'];
document.title = title + ' | ArtSouthwest';
createRoot(document.getElementById('root')).render(<Layout><Page /></Layout>);
