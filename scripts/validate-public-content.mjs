import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const allowArticleSetChanges = args.includes('--allow-article-set-changes');
const errors = [];

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontMatter(content, articlePath) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    errors.push(`${articlePath}: Front Matterが見つかりません。`);
    return undefined;
  }

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field) {
      if (fields.has(field[1])) {
        errors.push(`${articlePath}: Front Matterの${field[1]}が重複しています。`);
      }
      fields.set(field[1], field[2]);
    }
  }
  return fields;
}

function extractImageTargets(content) {
  const targets = [];
  const markdownImage = /!\[[^\]]*\]\(([^)\n]+)\)/g;
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

  for (const match of content.matchAll(markdownImage)) {
    const raw = match[1].trim();
    if (raw.startsWith('<')) {
      const end = raw.indexOf('>');
      targets.push(end >= 0 ? raw.slice(1, end) : raw);
    } else {
      targets.push(raw.split(/\s+/)[0]);
    }
  }
  for (const match of content.matchAll(htmlImage)) {
    targets.push(match[1].trim());
  }
  return targets;
}

function validateImageTarget(target, articlePath) {
  if (/^(?:https?:|data:|#)/i.test(target)) {
    return undefined;
  }
  if (!target.startsWith('/images/')) {
    errors.push(`${articlePath}: ローカル画像は/images/から始めてください: ${target}`);
    return undefined;
  }

  const withoutQuery = target.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    errors.push(`${articlePath}: 画像パスをURLデコードできません: ${target}`);
    return undefined;
  }

  if (decoded.includes('\\') || decoded.split('/').includes('..')) {
    errors.push(`${articlePath}: 画像パスに不正な移動要素があります: ${target}`);
    return undefined;
  }

  const relativePath = decoded.slice(1);
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  const imagesRoot = `${path.resolve(root, 'images')}${path.sep}`;
  if (!absolutePath.startsWith(imagesRoot)) {
    errors.push(`${articlePath}: imagesディレクトリ外を参照しています: ${target}`);
    return undefined;
  }
  if (!fs.existsSync(absolutePath) || !fs.lstatSync(absolutePath).isFile()) {
    errors.push(`${articlePath}: 参照画像が存在しません: ${target}`);
  }
  return relativePath;
}

function listImageFiles(relativeDirectory = 'images') {
  const directory = path.join(root, ...relativeDirectory.split('/'));
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      errors.push(`${relativePath}: シンボリックリンクは使用できません。`);
    } else if (entry.isDirectory()) {
      files.push(...listImageFiles(relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      errors.push(`${relativePath}: 通常ファイルではありません。`);
    }
  }
  return files;
}

function validateArticles() {
  const articlesRoot = path.join(root, 'articles');
  if (!fs.existsSync(articlesRoot)) {
    errors.push('articlesディレクトリが存在しません。');
    return 0;
  }

  const entries = fs.readdirSync(articlesRoot, { withFileTypes: true });
  const referencedImages = new Set();
  let articleCount = 0;
  for (const entry of entries) {
    const articlePath = `articles/${entry.name}`;
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      errors.push(`${articlePath}: articles直下にはMarkdown記事だけを配置してください。`);
      continue;
    }

    articleCount += 1;
    const slug = entry.name.slice(0, -3);
    if (!/^[a-z0-9_-]{12,50}$/.test(slug)) {
      errors.push(`${articlePath}: slugは半角英数字・ハイフン・アンダースコアの12〜50文字にしてください。`);
    }

    const absolutePath = path.join(articlesRoot, entry.name);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      errors.push(`${articlePath}: シンボリックリンクは使用できません。`);
      continue;
    }

    const content = fs.readFileSync(absolutePath, 'utf8');
    const fields = parseFrontMatter(content, articlePath);
    if (fields) {
      if (stripQuotes(fields.get('published') ?? '') !== 'true') {
        errors.push(`${articlePath}: Publicにはpublished: trueの記事だけを配置してください。`);
      }
      if (!stripQuotes(fields.get('title') ?? '')) {
        errors.push(`${articlePath}: titleが空です。`);
      }
      if (!['tech', 'idea'].includes(stripQuotes(fields.get('type') ?? ''))) {
        errors.push(`${articlePath}: typeはtechまたはideaにしてください。`);
      }
      if (!stripQuotes(fields.get('emoji') ?? '')) {
        errors.push(`${articlePath}: emojiが空です。`);
      }
    }

    for (const target of extractImageTargets(content)) {
      const imagePath = validateImageTarget(target, articlePath);
      if (imagePath) {
        referencedImages.add(imagePath);
      }
    }
  }

  for (const imagePath of listImageFiles()) {
    if (!referencedImages.has(imagePath)) {
      errors.push(`${imagePath}: どの記事からも参照されていません。`);
    }
  }
  return articleCount;
}

function validateChangedPaths() {
  if (!baseRef) {
    return;
  }

  let output;
  try {
    output = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-status', '-z', baseRef, 'HEAD'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    errors.push(`差分の取得に失敗しました: ${error.message}`);
    return;
  }

  const parts = output.split('\0').filter(Boolean);
  let changedArticleCount = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index];
    const changedPath = toPosix(parts[index + 1] ?? '');
    const isArticle = /^articles\/[^/]+\.md$/.test(changedPath);
    const isImage = /^images\/.+/.test(changedPath);

    if (!isArticle && !isImage) {
      errors.push(`Pull Requestで変更できないパスです: ${changedPath}`);
      continue;
    }
    if (isArticle) {
      changedArticleCount += 1;
      if (!allowArticleSetChanges && /^[AD]/.test(status)) {
        errors.push(`読者PRでは記事の追加・削除はできません: ${status} ${changedPath}`);
      }
    }
  }

  if (changedArticleCount === 0) {
    errors.push('少なくとも1つの既存記事を変更してください。');
  }
}

const articleCount = validateArticles();
validateChangedPaths();

if (errors.length > 0) {
  console.error('公開記事の検証に失敗しました:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`公開記事${articleCount}件を検証しました。`);
