const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nhat2025';
const SESSION_SECRET = process.env.SESSION_SECRET || 'blog-secret-please-change';
const SUPPORTED_LANGS = ['vi', 'en'];

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now().toString(36) + Math.random().toString(36).substr(2, 5) + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Migrate old flat-format posts to bilingual structure
function migratePost(post) {
  if (post.vi || post.en) return post; // already new format
  return {
    ...post,
    vi: {
      title: post.title || '',
      excerpt: post.excerpt || '',
      content: post.content || ''
    },
    en: { title: '', excerpt: '', content: '' },
    title: undefined,
    excerpt: undefined,
    content: undefined
  };
}

function readPosts(workspace) {
  const filePath = path.join(DATA_DIR, `${workspace}-posts.json`);
  try {
    if (!fs.existsSync(filePath)) return [];
    const posts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return posts.map(migratePost);
  } catch {
    return [];
  }
}

function writePosts(workspace, posts) {
  const filePath = path.join(DATA_DIR, `${workspace}-posts.json`);
  fs.writeFileSync(filePath, JSON.stringify(posts, null, 2));
}

// Resolve a post to a specific language, with fallback
function resolveLang(post, requestedLang) {
  const hasLang = {
    vi: !!(post.vi && post.vi.title),
    en: !!(post.en && post.en.title)
  };

  let actualLang = requestedLang;
  if (!hasLang[requestedLang]) {
    // fallback to the other available language
    actualLang = SUPPORTED_LANGS.find(l => hasLang[l]) || requestedLang;
  }

  const langData = post[actualLang] || {};

  const resolved = { ...post };
  delete resolved.vi;
  delete resolved.en;

  return {
    ...resolved,
    title: langData.title || '',
    excerpt: langData.excerpt || '',
    content: langData.content || '',
    lang: actualLang,
    requestedLang,
    hasLang
  };
}

function parseTags(t) {
  if (Array.isArray(t)) return t.filter(Boolean);
  return (t || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Middleware ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(__dirname, { index: false }));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Sai mật khẩu' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ── Public API ──
app.get('/api/posts', (req, res) => {
  const { workspace, lang = 'vi' } = req.query;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  const posts = readPosts(workspace)
    .filter(p => p.published)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(p => {
      const resolved = resolveLang(p, lang);
      if (p.private) resolved.content = '';
      return resolved;
    });
  res.json(posts);
});

app.get('/api/posts/:id', (req, res) => {
  const { workspace, lang = 'vi' } = req.query;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  const posts = readPosts(workspace);
  const post = posts.find(p => p.id === req.params.id && p.published);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.private) return res.status(403).json({ error: 'private' });
  res.json(resolveLang(post, lang));
});

app.post('/api/posts/:id/unlock', (req, res) => {
  const { workspace, lang = 'vi', password } = req.body;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  const posts = readPosts(workspace);
  const post = posts.find(p => p.id === req.params.id && p.published && p.private);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'wrong_password' });
  }
  res.json(resolveLang(post, lang));
});

// ── Admin API ──
app.get('/api/admin/posts', requireAuth, (req, res) => {
  const { workspace } = req.query;
  if (workspace && ['life', 'work'].includes(workspace)) {
    return res.json(readPosts(workspace).sort((a, b) => new Date(b.date) - new Date(a.date)));
  }
  const life = readPosts('life').map(p => ({ ...p, workspace: 'life' }));
  const work = readPosts('work').map(p => ({ ...p, workspace: 'work' }));
  res.json([...life, ...work].sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/admin/posts/:id', requireAuth, (req, res) => {
  const { workspace } = req.query;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  const post = readPosts(workspace).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

app.post('/api/admin/posts', requireAuth, (req, res) => {
  const { workspace, vi, en, tags, date, readTime, featured, published, private: isPrivate } = req.body;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  if (!(vi?.title) && !(en?.title)) {
    return res.status(400).json({ error: 'Cần ít nhất một ngôn ngữ có tiêu đề' });
  }

  const posts = readPosts(workspace);

  if (featured && workspace === 'life') {
    posts.forEach(p => { p.featured = false; });
  }

  const newPost = {
    id: generateId(),
    vi: {
      title: vi?.title || '',
      excerpt: vi?.excerpt || '',
      content: vi?.content || ''
    },
    en: {
      title: en?.title || '',
      excerpt: en?.excerpt || '',
      content: en?.content || ''
    },
    tags: parseTags(tags),
    date: date || new Date().toISOString().split('T')[0],
    readTime: readTime || '5',
    featured: !!featured,
    published: published === true || published === 'true',
    private: !!isPrivate,
    workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  posts.unshift(newPost);
  writePosts(workspace, posts);
  res.json(newPost);
});

app.put('/api/admin/posts/:id', requireAuth, (req, res) => {
  const { workspace } = req.query;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }

  const posts = readPosts(workspace);
  const idx = posts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Post not found' });

  const { vi, en, tags, date, readTime, featured, published, private: isPrivate } = req.body;

  if (featured && workspace === 'life') {
    posts.forEach(p => { p.featured = false; });
  }

  posts[idx] = {
    ...posts[idx],
    vi: {
      title: vi?.title ?? posts[idx].vi?.title ?? '',
      excerpt: vi?.excerpt ?? posts[idx].vi?.excerpt ?? '',
      content: vi?.content ?? posts[idx].vi?.content ?? ''
    },
    en: {
      title: en?.title ?? posts[idx].en?.title ?? '',
      excerpt: en?.excerpt ?? posts[idx].en?.excerpt ?? '',
      content: en?.content ?? posts[idx].en?.content ?? ''
    },
    tags: parseTags(tags),
    date: date || posts[idx].date,
    readTime: readTime || posts[idx].readTime,
    featured: !!featured,
    published: published === true || published === 'true',
    private: !!isPrivate,
    updatedAt: new Date().toISOString()
  };

  writePosts(workspace, posts);
  res.json(posts[idx]);
});

app.delete('/api/admin/posts/:id', requireAuth, (req, res) => {
  const { workspace } = req.query;
  if (!workspace || !['life', 'work'].includes(workspace)) {
    return res.status(400).json({ error: 'Invalid workspace' });
  }
  const posts = readPosts(workspace);
  const filtered = posts.filter(p => p.id !== req.params.id);
  if (filtered.length === posts.length) {
    return res.status(404).json({ error: 'Post not found' });
  }
  writePosts(workspace, filtered);
  res.json({ success: true });
});

// ── Image API ──
app.post('/api/admin/images', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

app.get('/api/admin/images', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f))
      .map(f => ({ filename: f, url: `/uploads/${f}`, mtime: fs.statSync(path.join(UPLOADS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.delete('/api/admin/images/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// ── Page Routes ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/life', (req, res) => res.sendFile(path.join(__dirname, 'life.html')));
app.get('/work', (req, res) => res.sendFile(path.join(__dirname, 'work.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  Blog:  http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  console.log(`  Pass:  ${ADMIN_PASSWORD}\n`);
});
