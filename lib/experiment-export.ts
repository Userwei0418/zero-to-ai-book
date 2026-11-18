import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { CellResult, RegisteredCell } from './notebook-runtime';

export type ExperimentFormat = 'py' | 'ipynb' | 'zip';
type Contents = Record<string, string>;
type Input = {
  chapterId: string; cells: RegisteredCell[]; files: Contents; originals?: Contents;
  results: Record<string, CellResult>; support?: Contents;
};
type Unit = { name: string; file: string; location: string; runtime: string };

const pythonLanguages = ['python', 'py', 'python3'];
const pythonCell = (cell: RegisteredCell) => pythonLanguages.includes((cell.block.language || 'python').toLowerCase());
const executable = (cell: RegisteredCell) => pythonCell(cell) && cell.block.runnable !== false;

// Portable relative paths only. Refuse an invalid project as a whole instead of dropping a file silently.
function checkPath(path: string) {
  if (!path || /[\\:\x00-\x1f<>|?*"]/.test(path) || path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(?:__proto__|prototype|constructor|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`项目内含不支持的文件路径：${path}`);
  }
}

function encodeZip(files: Contents) {
  const names = Object.keys(files).sort();
  const paths = new Set<string>();
  const dirs = new Set<string>();
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const name of names) {
    checkPath(name);
    const key = name.normalize('NFC').toLowerCase();
    if (paths.has(key) || dirs.has(key)) throw new Error(`项目内的文件名冲突：${name}`);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (paths.has(dir)) throw new Error(`文件与目录冲突：${name}`);
      dirs.add(dir);
    }
    paths.add(key);
    entries[name] = strToU8(files[name]);
  }
  return zipSync(entries, { level: 4 });
}

export function decodeExperimentSupport(bytes: Uint8Array): Contents {
  const entries = unzipSync(bytes);
  return Object.fromEntries(Object.entries(entries).map(([name, value]) => {
    checkPath(name);
    return [name, strFromU8(value)];
  }));
}

let lowerSupport: Promise<Contents> | undefined;
export async function loadExperimentSupport(chapterId: string) {
  if (!/^lower-\d\d$/.test(chapterId)) return {};
  if (!lowerSupport) lowerSupport = fetch('/course/experiment-support.zip').then(async response => {
    if (!response.ok) throw new Error();
    return decodeExperimentSupport(new Uint8Array(await response.arrayBuffer()));
  }).catch(() => {
    lowerSupport = undefined;
    throw new Error('跨章实验资料未下载完整，请检查网络后重试。');
  });
  return lowerSupport;
}

function projectFiles(input: Input) {
  const number = /^lower-(\d\d)$/.exec(input.chapterId)?.[1];
  const folder = number ? `下册/课件/ch${number}` : 'project';
  const files: Contents = Object.create(null);
  if (number) {
    if (!input.support || !Object.keys(input.support).some(name => name.startsWith(folder + '/'))) {
      throw new Error('缺少本章跨章实验资料。');
    }
    for (const [name, value] of Object.entries(input.support)) {
      const sub = /^下册\/课件\/ch(\d\d)\//.exec(name);
      if (name.startsWith('上册/') || (sub && sub[1] <= number)) files[name] = value;
    }
  }
  const published = Object.entries(files);
  for (const [name, value] of Object.entries(input.files)) {
    checkPath(name);
    files[`${folder}/${name}`] = value;
    const original = input.originals?.[name];
    if (original === undefined || original === value) continue;
    // A reader may have edited an inherited flat module. Older imports resolve via ../chNN/.
    for (const [path, source] of published) {
      if (path.startsWith('下册/') && path.endsWith('/' + name) && source.trim() === original.trim()) files[path] = value;
    }
  }
  const units: Unit[] = [];
  const locations = new Map<string, string>();
  input.cells.forEach((cell, index) => {
    if (!executable(cell)) return;
    const name = cell.block.filename || `cell-${index + 1}.py`;
    checkPath(name);
    const nested = published.find(([path, original]) =>
      path.startsWith(folder + '/') && path !== `${folder}/${name}` &&
      path.endsWith('/' + name) && original.trim() === cell.block.code?.trim());
    const location = nested?.[0] || `${folder}/${name}`;
    const unitName = `units/${index + 1}.py`;
    // Full modules are edited in place; excerpts with separate code have their own script.
    const original = input.originals?.[name];
    if (cell.value !== cell.block.code && original?.trim() === cell.block.code?.trim()) files[location] = cell.value;
    if (files[location] === undefined) files[location] = cell.value;
    const matches = files[location].trim() === cell.value.trim();
    // A nested module may have been edited via the file browser while its flat cell stayed unchanged.
    const useFile = matches || (nested && cell.value === cell.block.code);
    if (!useFile) files[unitName] = cell.value;
    units.push({ name, location, file: useFile ? location : unitName, runtime: cell.block.runtime || 'browser' });
    locations.set(cell.block.id, location);
  });
  return { folder, files, units, locations };
}

function requirements(input: Input, folder: string) {
  const packages: Record<string, string> = { numpy: 'numpy', pandas: 'pandas', matplotlib: 'matplotlib', torch: 'torch', requests: 'requests', httpx: 'httpx', openai: 'openai', PIL: 'Pillow', sklearn: 'scikit-learn' };
  const dependencies = new Set<string>();
  const visited = new Set<string>();
  const inspect = (code: string) => {
    for (const match of code.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([^#;\n]+))/gm)) {
      const names = match[1] ? [match[1]] : match[2].split(',').map(item => item.trim().split(/\s+/)[0]);
      for (const name of names) {
        if (visited.has(name)) continue;
        visited.add(name);
        const path = name.replaceAll('.', '/');
        const local = input.files[path + '.py'] ?? input.files[path + '/__init__.py'];
        if (local !== undefined) inspect(local);
        else if (Object.hasOwn(packages, name.split('.')[0])) dependencies.add(packages[name.split('.')[0]]);
      }
    }
  };
  for (const cell of input.cells.filter(executable)) inspect(cell.value);
  const deps = [...dependencies].sort();
  if (input.files['requirements.txt']) deps.push(`-r ${folder}/requirements.txt`);
  return [...deps, '# PDF 提取可选：python -m pip install pypdf', '# 本地打开 Notebook 可另装：python -m pip install jupyterlab'].join('\n') + '\n';
}

function asBase64(bytes: Uint8Array) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 16384) parts.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(parts.join(''));
}

function pythonSetup(folder: string, data?: Uint8Array) {
  const lines = [
    'from pathlib import Path as _BookPath',
    'import os as _book_os, sys as _book_sys',
  ];
  if (data) lines.push(
    'import base64 as _book_b64, io as _book_io, tempfile as _book_tmp, zipfile as _book_zip',
    '_book_root = _BookPath(_book_tmp.mkdtemp(prefix="ai-book-"))',
    `with _book_zip.ZipFile(_book_io.BytesIO(_book_b64.b64decode("${asBase64(data)}"))) as _archive:`,
    '    _archive.extractall(_book_root)',
  );
  else lines.push(
    '_book_cwd = _BookPath.cwd().resolve()',
    '_book_root = next((p for p in (_book_cwd, *_book_cwd.parents) if (p / "chapter.ipynb").is_file() and (p / "run.py").is_file()), _book_cwd)',
  );
  return [...lines,
    `_book_chapter = _book_root / ${JSON.stringify(folder)}`,
    'def _book_enter(relative):',
    '    path = _book_root / relative',
    '    _book_os.chdir(_book_chapter)',
    '    _book_sys.argv = [str(path)]',
    '    for folder in (str(_book_chapter), str(path.parent)):',
    '        if folder in _book_sys.path: _book_sys.path.remove(folder)',
    '        _book_sys.path.insert(0, folder)',
    '    return str(path)',
    '_book_chapter.mkdir(parents=True, exist_ok=True)',
    '_book_os.chdir(_book_chapter)',
    'print("实验目录", _book_chapter)',
  ].join('\n');
}

function runner(folder: string, units: Unit[], data?: Uint8Array) {
  const setup = pythonSetup(folder, data).replace('_book_cwd = _BookPath.cwd().resolve()', '_book_cwd = _BookPath(__file__).resolve().parent');
  return [
    '# -*- coding: utf-8 -*-', 'import json', 'import sys', 'args = sys.argv[1:]',
    `units = json.loads(${JSON.stringify(JSON.stringify(units))})`,
    'if args == ["--list"] or (not args and any(unit["runtime"] != "browser" for unit in units)):',
    '    for number, unit in enumerate(units, 1): print(number, unit["name"], unit["runtime"])',
    '    print("运行指定单元：python run.py 编号；运行整章：python run.py --all")',
    '    raise SystemExit(0)',
    'if args and args != ["--all"]:',
    '    if len(args) != 1 or not args[0].isdigit() or not 1 <= int(args[0]) <= len(units):',
    '        raise SystemExit("请输入有效单元编号，或使用 --list")',
    '    units = [units[int(args[0]) - 1]]',
    setup, 'session = {"__name__": "__main__"}',
    'for unit in units:',
    '    location = _book_enter(unit["location"])',
    '    session["__file__"] = location',
    '    sys.argv = [location]',
    '    code = (_book_root / unit["file"]).read_text(encoding="utf-8")',
    '    print("\\n▶", unit["name"], flush=True)',
    '    exec(compile(code, location, "exec"), session)',
    '',
  ].join('\n');
}

function notebook(input: Input, project: ReturnType<typeof projectFiles>, data?: Uint8Array) {
  const setup = pythonSetup(project.folder, data);
  const cells: Array<Record<string, unknown>> = [
    { cell_type: 'markdown', id: 'book-instructions', metadata: {}, source: data ? '先运行准备单元。它会在新的临时目录还原项目文件，随后按课文顺序运行实验。模型相关单元需要在本机配置环境变量。' : '在解压根目录打开本 Notebook，先运行准备单元，然后逐格实验。修改的项目文件可在同目录找到。' },
    { cell_type: 'code', id: 'book-setup', metadata: { jupyter: { source_hidden: true } }, source: setup, execution_count: null, outputs: [] },
  ];
  input.cells.forEach((cell, index) => {
    const id = `book-cell-${index + 1}`;
    if (!executable(cell)) {
      cells.push({ cell_type: 'markdown', id, metadata: {}, source: '```' + (cell.block.language || '') + '\n' + cell.value + '\n```' });
      return;
    }
    const result = input.results[cell.block.id];
    const outputs: unknown[] = [];
    if (result?.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: result.stdout });
    if (result?.stderr) outputs.push({ output_type: 'stream', name: 'stderr', text: result.stderr });
    if (result?.error) outputs.push({ output_type: 'error', ename: 'ExecutionError', evalue: result.error, traceback: result.error.split('\n') });
    result?.images.forEach(image => outputs.push({ output_type: 'display_data', data: { 'image/png': image.replace(/^data:image\/png;base64,/, '') }, metadata: {} }));
    result?.tables?.forEach(table => outputs.push({ output_type: 'display_data', data: { 'text/plain': [table.columns, ...table.rows].map(row => row.join('\t')).join('\n'), 'application/json': table }, metadata: {} }));
    // Separate setup preserves Python syntax, including future imports, in the editable cell.
    const location = project.locations.get(cell.block.id)!;
    cells.push({ cell_type: 'code', id: id + '-path', metadata: { jupyter: { source_hidden: true } }, source: `__file__ = _book_enter(${JSON.stringify(location)})`, execution_count: null, outputs: [] });
    const unit = project.units.find(entry => entry.location === location && entry.name === cell.block.filename);
    const value = unit && cell.value === cell.block.code && unit.file === unit.location ? project.files[unit.file] : cell.value;
    cells.push({ cell_type: 'code', id, metadata: {}, source: value, execution_count: result?.executionCount ?? null, outputs });
  });
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, cells }, null, 2);
}

export function createExperiment(input: Input, format: ExperimentFormat): Blob {
  const project = projectFiles(input);
  if (format !== 'zip') {
    const data = encodeZip({ ...project.files, 'requirements.txt': requirements(input, project.folder) });
    return new Blob([format === 'py' ? runner(project.folder, project.units, data) : notebook(input, project, data)], { type: format === 'py' ? 'text/x-python;charset=utf-8' : 'application/x-ipynb+json' });
  }
  const readme = [
    `# 零基础学 AI · ${input.chapterId}`, '', '解压整个目录，使用 Python 3.10 或更高版本，在含 run.py 的目录打开终端。', '',
    '1. 执行 `python run.py --list` 查看单元，再用 `python run.py 1` 运行第一个单元。',
    '2. 按顺序运行整章用 `python run.py --all`。代码共享变量，遇到报错时停止。有些单元会向模型发请求、等待输入或启动服务。',
    '3. 使用 Notebook 时，在这里启动 Jupyter 并打开 chapter.ipynb。运行第一个准备单元后，可以逐个修改、运行代码。',
    '', `项目文件在 ${project.folder}/。课程原文中的命令请在对应章节目录内执行。`,
    'requirements.txt 包含已识别的当前单元 Python 依赖，可在虚拟环境中执行 `python -m pip install -r requirements.txt`。自加库按其说明安装。',
    ...(input.chapterId.startsWith('lower-') ? ['', '下册保留课件的 chNN 相邻目录、已有数据和 Skill 文件。上册目录收录网页 25 篇正文转换的 Markdown，可用于扫描与重新建索引。既有 chunks.jsonl 保留课件原索引及行号，其中引用的六个视频与一份视频制作笔记仅提供索引记录。重新生成索引时，正文格式和行号可能变化。模型权重和个人语料需要自行提供。', 'PDF 可选装 pypdf。音视频处理可能需要 ffmpeg 和转录服务。', ...(input.chapterId === 'lower-12' ? ['毕业项目可在 ch12 下执行 `python -m pip install -e ./mykb_pkg`。'] : [])] : []),
    ...(project.units.some(unit => unit.runtime !== 'browser') ? ['', '有联网、服务进程或本机环境依赖的实验请按课文逐项运行。模型实验从本机的 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL 等环境变量读取配置。'] : []),
    '', '## 课文顺序', '', ...project.units.map((unit, index) => `${index + 1}. ${unit.name} (${unit.runtime})`), '',
  ].join('\n');
  const archive = encodeZip({ ...project.files, 'run.py': runner(project.folder, project.units), 'chapter.ipynb': notebook(input, project), 'requirements.txt': requirements(input, project.folder), 'README.md': readme });
  return new Blob([new Uint8Array(archive).buffer], { type: 'application/zip' });
}
