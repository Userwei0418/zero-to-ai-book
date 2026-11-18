import type { CourseBlock, RuntimeKind } from './course-types';

export type TableOutput = { columns: string[]; rows: string[][]; truncated?: boolean };
export type CellResult = {
  code: string;
  status: 'running' | 'ok' | 'error' | 'interrupted';
  stdout: string;
  stderr: string;
  images: string[];
  tables?: TableOutput[];
  /** Large images stay in session memory; an exported Notebook retains them. */
  mediaOmitted?: boolean;
  inputsChanged?: boolean;
  executionCount?: number;
  elapsedMs?: number;
  error?: string;
  historical?: boolean;
  runtime?: RuntimeKind;
};
export type RegisteredCell = { block: CourseBlock; value: string };
export type NotebookSnapshot = {
  phase: 'idle' | 'loading' | 'ready' | 'running' | 'error';
  message: string;
  activeCell?: string;
  batch: boolean;
  count: number;
  results: Record<string, CellResult>;
  environment: 'browser' | 'remote' | 'split';
  persistenceError?: string;
  batchProgress?: { completed: number; total: number; targetCell?: string };
};

type WorkerReply = {
  type: 'status' | 'started' | 'chunk' | 'image' | 'table' | 'result' | 'fatal';
  id: string;
  message?: string;
  text?: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  table?: TableOutput;
  ok?: boolean;
  error?: string;
  executionCount?: number;
  elapsedMs?: number;
};

const MAX_CODE = 160000;
const MAX_OUTPUT = 131072;
const MAX_IMAGE = 2800000;
const BROWSER_TIME_LIMIT = 60000;
const REMOTE_TIME_LIMIT = 90000;
const kernels = new Map<string, NotebookKernel>();
const EMPTY_FILES: Record<string, string> = {};

export function browserRunnable(block: CourseBlock): boolean {
  return block.type === 'code' && block.runnable !== false && (!block.language || ['python', 'py', 'python3'].includes(block.language.toLowerCase()));
}

export function runtimeUnavailable(runtime: RuntimeKind, remote?: boolean, gpu?: boolean): string | undefined {
  if (runtime === 'browser') return;
  const configured = runtime === 'gpu' ? gpu : remote;
  if (configured) return;
  const label = runtime === 'gpu' ? 'GPU' : runtime === 'api' ? 'API 实验' : 'Linux';
  return configured === false ? label + ' 环境未连接' : label + ' 环境连接待确认';
}

export function getNotebookKernel(chapterId: string, cacheScope?: string): NotebookKernel {
  if (typeof window === 'undefined' || !cacheScope || cacheScope === 'pending') return new NotebookKernel(chapterId, cacheScope);
  const key = JSON.stringify([cacheScope, chapterId]);
  let kernel = kernels.get(key);
  if (!kernel) kernel = new NotebookKernel(chapterId, cacheScope);
  kernels.delete(key);
  kernels.set(key, kernel);
  while (kernels.size > 3) {
    const oldest = kernels.entries().next().value;
    if (!oldest) break;
    oldest[1].release();
    kernels.delete(oldest[0]);
  }
  return kernel;
}

export type RunHistory = Record<string, { status: CellResult['status']; historical: boolean }>;

function historyKey(scope: string, chapterId: string) {
  return 'ai-book-results-v2:' + encodeURIComponent(scope) + ':' + encodeURIComponent(chapterId);
}
function legacyHistoryKey(scope: string, chapterId: string) {
  return 'ai-book-results-v1:' + scope + ':' + chapterId;
}

function readSavedResults(cacheScope: string, chapterId: string) {
  try {
    let raw = localStorage.getItem(historyKey(cacheScope, chapterId));
    let legacyKey: string | undefined;
    if (!raw) {
      legacyKey = legacyHistoryKey(cacheScope, chapterId);
      raw = localStorage.getItem(legacyKey);
    }
    if (!raw || raw.length > 800000) return;
    const saved: unknown = JSON.parse(raw);
    const results: Record<string, CellResult> = Object.create(null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [id, input] of Object.entries(saved).slice(-60)) {
      const item = input as Partial<CellResult>;
      if (!item || typeof item.code !== 'string' || typeof item.stdout !== 'string' || typeof item.stderr !== 'string') continue;
      if (!['ok', 'error', 'interrupted'].includes(item.status || '')) continue;
      results[id] = {
        code: item.code.slice(0, MAX_CODE), status: item.status as CellResult['status'],
        stdout: item.stdout.slice(0, 32000), stderr: item.stderr.slice(0, 16000), images: [],
        tables: safeTables(item.tables), mediaOmitted: item.mediaOmitted === true || Boolean(item.images?.length), inputsChanged: item.inputsChanged === true,
        executionCount: typeof item.executionCount === 'number' ? item.executionCount : undefined,
        elapsedMs: typeof item.elapsedMs === 'number' ? item.elapsedMs : undefined,
        error: typeof item.error === 'string' ? item.error.slice(0, 16000) : undefined,
        historical: true,
        runtime: ['browser', 'linux', 'api', 'gpu'].includes(item.runtime || '') ? item.runtime : undefined,
      };
    }
    return { results, legacyKey };
  } catch { return; }
}

/** Inspect a chapter without creating a kernel or evicting another chapter's variables. */
export function readChapterRunHistory(cacheScope: string, chapterId: string): RunHistory {
  if (!cacheScope || cacheScope === 'pending' || typeof window === 'undefined') return {};
  const active = kernels.get(JSON.stringify([cacheScope, chapterId]));
  const results = active?.getHistoryResults() ?? readSavedResults(cacheScope, chapterId)?.results ?? {};
  return Object.fromEntries(Object.entries(results).map(([id, value]) => [
    id, { status: value.status, historical: Boolean(value.historical) },
  ]));
}

/** Only observe already-mounted sessions while the records drawer is open. */
export function subscribeRunHistory(cacheScope: string, refresh: () => void) {
  const cleanups = [...kernels.values()]
    .filter(kernel => kernel.cacheScope === cacheScope)
    .map(kernel => kernel.subscribe(refresh));
  return () => cleanups.forEach(cleanup => cleanup());
}

export function clearNotebookHistory(cacheScope: string) {
  for (const kernel of kernels.values()) {
    // Keep mounted Providers and file tools on the same now-empty instance.
    if (kernel.cacheScope === cacheScope) kernel.clearHistory();
  }
  if (typeof window === 'undefined') return;
  try {
    const prefixes = ['ai-book-results-v2:' + encodeURIComponent(cacheScope) + ':', 'ai-book-results-v1:' + cacheScope + ':'];
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch { /* Cache access may be disabled by the browser. */ }
}

function remoteImages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const images: string[] = [];
  for (const item of input) {
    const data = typeof item === 'string' ? item : item && typeof item === 'object' && item.mimeType === 'image/png' ? item.data : undefined;
    if (typeof data !== 'string' || data.length > MAX_IMAGE || !/^(?:data:image\/png;base64,)?[A-Za-z0-9+/=]+$/.test(data)) continue;
    images.push(data.startsWith('data:') ? data : 'data:image/png;base64,' + data);
    if (images.length === 4) break;
  }
  return images;
}

function validTable(input: unknown): input is TableOutput {
  if (!input || typeof input !== 'object') return false;
  const table = input as TableOutput;
  return Array.isArray(table.columns) && table.columns.length > 0 && table.columns.length <= 20 &&
    table.columns.every(value => typeof value === 'string' && value.length <= 1000) &&
    Array.isArray(table.rows) && table.rows.length <= 100 &&
    table.rows.every(row => Array.isArray(row) && row.length === table.columns.length && row.every(value => typeof value === 'string' && value.length <= 4000)) &&
    (table.truncated === undefined || typeof table.truncated === 'boolean') && JSON.stringify({ columns: table.columns, rows: table.rows, truncated: table.truncated }).length <= MAX_OUTPUT;
}

function safeTables(input: unknown): TableOutput[] {
  if (!Array.isArray(input)) return [];
  let remaining = MAX_OUTPUT;
  return input.filter(validTable).slice(0, 4).map(table => ({ columns: table.columns, rows: table.rows, ...(table.truncated === undefined ? {} : { truncated: table.truncated }) })).filter(table => { remaining -= JSON.stringify(table).length; return remaining >= 0; });
}

function historyText(text: string, limit: number) {
  return text.length <= limit ? text : text.slice(0, limit) + '\n[本机历史只保留了这段输出的前部；完整结果请在运行后下载 Notebook。]\n';
}

function validReply(input: unknown, id: string): input is WorkerReply {
  if (!input || typeof input !== 'object') return false;
  const value = input as WorkerReply;
  if (value.id !== id || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'status': return typeof value.message === 'string' && value.message.length <= 500;
    case 'started': return Number.isSafeInteger(value.executionCount) && (value.executionCount || 0) > 0;
    case 'chunk': return (value.stream === 'stdout' || value.stream === 'stderr') && typeof value.text === 'string' && value.text.length <= 8192;
    case 'image': return typeof value.data === 'string' && value.data.length <= MAX_IMAGE && /^[A-Za-z0-9+/=]+$/.test(value.data);
    case 'table': return validTable(value.table);
    case 'fatal': return typeof value.error === 'string' && value.error.length <= 32000;
    case 'result': return typeof value.ok === 'boolean' && (value.error === undefined || typeof value.error === 'string' && value.error.length <= 32000) && (value.executionCount === undefined || Number.isSafeInteger(value.executionCount)) && typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs);
    default: return false;
  }
}

function sandboxDocument(token: string, source: string): string {
  // No allow-same-origin: Python's js bridge cannot read site cookies, storage, DOM,
  // or authenticated endpoints. The only network origin is the pinned public CDN.
  const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net/pyodide/v0.27.7/full/; connect-src https://cdn.jsdelivr.net/pyodide/v0.27.7/full/; worker-src blob:; child-src blob:; img-src data:; base-uri 'none'; form-action 'none';";
  const bootstrap = `(() => {
    const token = ${JSON.stringify(token)};
    const source = ${JSON.stringify(source)};
    let connected = false;
    addEventListener('message', function connect(event) {
      if (connected || event.source !== parent || event.data?.type !== 'notebook-connect' || event.data?.token !== token || event.ports.length !== 1) return;
      connected = true;
      removeEventListener('message', connect);
      const port = event.ports[0];
      const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      let activeId = '';
      worker.onmessage = (event) => port.postMessage(event.data);
      worker.onerror = (event) => port.postMessage({type: 'fatal', id: activeId, error: String(event.message || 'Python Worker 初始化失败').slice(0, 32000)});
      port.onmessage = (event) => {
        const request = event.data;
        if (request?.type === 'terminate') { worker.terminate(); port.postMessage({type: 'terminated'}); return; }
        if (!request || request.type !== 'execute' || typeof request.id !== 'string' || request.id.length > 100 || typeof request.code !== 'string' || request.code.length > ${MAX_CODE}) return;
        activeId = request.id;
        worker.postMessage(request);
      };
      port.start();
      port.postMessage({type: 'connected'});
    });
    parent.postMessage({type: 'notebook-ready', token}, '*');
  })();`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${bootstrap.replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`;
}

export class NotebookKernel {
  readonly chapterId: string;
  readonly cacheScope?: string;
  private state: NotebookSnapshot = { phase: 'idle', message: '点击运行，启动本章 Python', batch: false, count: 0, results: {}, environment: 'browser' };
  private listeners = new Set<() => void>();
  private cells = new Map<string, RegisteredCell>();
  private files: Record<string, string> = EMPTY_FILES;
  private exportOriginals: Record<string, string> = EMPTY_FILES;
  private iframe?: HTMLIFrameElement;
  private port?: MessagePort;
  private bridge?: Promise<MessagePort>;
  private bridgeReject?: (error: Error) => void;
  private current?: { id: string; cellId: string; finish: (result: CellResult) => void; timer: ReturnType<typeof setTimeout>; events: number; runtime: RuntimeKind };
  private controller?: AbortController;
  private generation = 0;
  private hydrated = false;
  private migratedLegacyKey?: string;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private usedRemote = false;
  private remoteConfigured?: boolean;
  private gpuConfigured?: boolean;
  private remoteKinds = new Set<'linux' | 'gpu'>();

  constructor(chapterId: string, cacheScope?: string) { this.chapterId = chapterId; this.cacheScope = cacheScope && cacheScope !== 'pending' ? cacheScope : undefined; }
  private cacheKey() { return this.cacheScope ? historyKey(this.cacheScope, this.chapterId) : undefined; }
  private legacyCacheKey() { return this.cacheScope ? legacyHistoryKey(this.cacheScope, this.chapterId) : undefined; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;

  private update(patch: Partial<NotebookSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
    if (typeof window !== 'undefined') {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persist(), 500);
    }
  }
  private patchResult(cellId: string, patch: Partial<CellResult>) {
    const old = this.state.results[cellId];
    if (!old) return;
    this.update({ results: { ...this.state.results, [cellId]: { ...old, ...patch } } });
  }
  getHistoryResults() {
    return this.hydrated || Object.keys(this.state.results).length ? this.state.results : undefined;
  }
  hydrate() {
    if (this.hydrated || typeof window === 'undefined' || !this.cacheScope) return;
    this.hydrated = true;
    const saved = readSavedResults(this.cacheScope, this.chapterId);
    if (!saved) return;
    this.migratedLegacyKey = saved.legacyKey;
    this.update({ results: { ...saved.results, ...this.state.results }, ...(Object.keys(saved.results).length && this.state.phase === 'idle' ? { message: '已恢复历史输出；运行变量不在历史记录中，请按顺序重新执行。' } : {}) });
  }
  private persist() {
    const key = this.cacheKey();
    if (!key) return;
    try {
      const saved = Object.fromEntries(Object.entries(this.state.results).filter(([, result]) => result.status !== 'running').slice(-40).map(([id, result]) => [id, {
        ...result, code: result.code.slice(0, 40000), stdout: historyText(result.stdout, 24000), stderr: historyText(result.stderr, 12000), images: [],
        tables: safeTables(result.tables), mediaOmitted: Boolean(result.images.length || result.mediaOmitted),
      }]));
      const value = JSON.stringify(saved);
      if (value.length > 750000) { this.setPersistenceError('本章输出较多，最新历史未保存到本机；请下载 Notebook 保留结果。'); return; }
      localStorage.setItem(key, value);
      if (this.migratedLegacyKey) { localStorage.removeItem(this.migratedLegacyKey); this.migratedLegacyKey = undefined; }
      this.setPersistenceError(undefined);
    } catch { this.setPersistenceError('浏览器空间不足或禁止存储，运行输出仅保留在当前页面；请下载 Notebook。'); }
  }
  private setPersistenceError(persistenceError?: string) {
    if (this.state.persistenceError === persistenceError) return;
    this.state = { ...this.state, persistenceError };
    this.listeners.forEach(listener => listener());
  }
  release() {
    this.stop('为节省内存，已回收较早章节的运行会话。历史输出保留；回到本章请从头运行。');
    clearTimeout(this.saveTimer);
    this.persist();
  }
  private markInputsChanged() {
    if (!Object.keys(this.state.results).length) return;
    this.update({ results: Object.fromEntries(Object.entries(this.state.results).map(([id, result]) => [id, { ...result, inputsChanged: true }])) });
  }
  setFiles(files?: Record<string, string>) {
    const next = files || EMPTY_FILES;
    if (Object.keys(next).length !== Object.keys(this.files).length || Object.keys(next).some(name => next[name] !== this.files[name])) this.markInputsChanged();
    this.files = next;
  }
  register(cell: RegisteredCell) {
    const old = this.cells.get(cell.block.id);
    if (old && old.value !== cell.value) this.markInputsChanged();
    this.cells.set(cell.block.id, cell); this.refreshEnvironment();
  }
  registerAll(cells: RegisteredCell[]) {
    const next = new Map<string, RegisteredCell>();
    for (const cell of cells) next.set(cell.block.id, cell);
    if (this.cells.size && (this.cells.size !== next.size || cells.some(cell => this.cells.get(cell.block.id)?.value !== cell.value))) this.markInputsChanged();
    this.cells = next;
    this.refreshEnvironment();
  }
  getCells() { return [...this.cells.values()]; }
  setRemoteConfigured(configured: boolean | undefined, gpuConfigured?: boolean) {
    if (configured === this.remoteConfigured && gpuConfigured === this.gpuConfigured) return;
    this.remoteConfigured = configured;
    this.gpuConfigured = gpuConfigured;
    this.refreshEnvironment(true);
  }
  unavailableReason(block: CourseBlock): string | undefined {
    return runtimeUnavailable(block.runtime || 'browser', this.remoteConfigured, this.gpuConfigured);
  }
  sequenceUnavailable(cells = this.getCells()): string | undefined {
    for (const { block } of cells) {
      if (!browserRunnable(block)) continue;
      const reason = this.unavailableReason(block);
      if (reason) return reason;
    }
  }
  private hasOrdinaryRemote() {
    return [...this.cells.values()].some(cell => browserRunnable(cell.block) && (cell.block.runtime === 'linux' || cell.block.runtime === 'api'));
  }
  runtimeFor(block: CourseBlock): RuntimeKind {
    if (block.runtime === 'gpu') return 'gpu';
    if (this.remoteConfigured && this.hasOrdinaryRemote()) return 'linux';
    return block.runtime || 'browser';
  }
  private refreshEnvironment(capabilitiesChanged = false) {
    const ordinaryRemote = this.hasOrdinaryRemote();
    const hasGPU = [...this.cells.values()].some(cell => browserRunnable(cell.block) && cell.block.runtime === 'gpu');
    const environment = this.remoteConfigured && ordinaryRemote ? 'remote' : ordinaryRemote || hasGPU ? 'split' : 'browser';
    if (environment === this.state.environment) {
      if (capabilitiesChanged) this.update({});
      return;
    }
    this.update({ environment, ...(!this.current ? { message: environment === 'remote' ? '本章普通 Python 单元共享同一云端会话；GPU 环境独立。' : environment === 'split' ? '浏览器与云端分别保存变量；云端单元需要连接运行服务。' : '点击运行，启动本章浏览器 Python' } : {}) });
  }
  clearHistory() {
    this.stop('本章运行记录已清空。');
    for (const runtime of this.remoteKinds) void this.remoteAction('reset', runtime);
    this.update({ results: {}, count: 0 });
    clearTimeout(this.saveTimer);
    try { for (const key of [this.cacheKey(), this.legacyCacheKey()]) if (key) localStorage.removeItem(key); } catch { /* optional cache */ }
  }
  private isCurrent(id: string) { return this.current?.id === id; }
  private effectiveFiles() {
    const files = { ...this.files };
    for (const cell of this.cells.values()) {
      const name = cell.block.filename;
      // Only overwrite an attached module when the cell represents that whole file.
      if (name && typeof files[name] === 'string' && typeof cell.block.code === 'string' && files[name].trim() === cell.block.code.trim()) files[name] = cell.value;
    }
    return files;
  }

  private async ensureBridge(): Promise<MessagePort> {
    if (this.port) return this.port;
    if (this.bridge) return this.bridge;
    const generation = this.generation;
    const bridge = (async () => {
      // The trusted page loads its own private static asset; only its text is
      // handed to the opaque sandbox. No credentials enter the Python worker.
      const response = await fetch('/runtime/python-worker.js', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Python 启动文件加载失败（${response.status}），请稍后重试。`);
      const source = await response.text();
      if (!source.includes('loadPyodide') || source.length > 100000) throw new Error('Python 启动文件无效，请刷新页面重试。');
      if (generation !== this.generation) throw new Error('运行已停止，会话已重置。');
      return await new Promise<MessagePort>((resolve, reject) => {
        const token = crypto.randomUUID();
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('title', '隔离的 Python 运行环境');
        frame.setAttribute('aria-hidden', 'true');
        frame.hidden = true;
        let done = false;
        const timeout = setTimeout(() => finish(new Error('Python 隔离环境启动超时，请检查网络后重试。')), 15000);
        const finish = (error?: Error, port?: MessagePort) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          window.removeEventListener('message', onReady);
          this.bridgeReject = undefined;
          if (error) { frame.remove(); reject(error); }
          else if (port) { this.port = port; resolve(port); }
        };
        const onReady = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.data?.type !== 'notebook-ready' || event.data?.token !== token) return;
          window.removeEventListener('message', onReady);
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => {
            if (!done && event.data?.type === 'connected') finish(undefined, channel.port1);
            else this.onReply(event.data);
          };
          channel.port1.onmessageerror = () => this.stop('运行环境通信失败；本章会话已重置。');
          channel.port1.start();
          frame.contentWindow?.postMessage({ type: 'notebook-connect', token }, '*', [channel.port2]);
        };
        this.bridgeReject = (error) => finish(error);
        window.addEventListener('message', onReady);
        this.iframe = frame;
        frame.srcdoc = sandboxDocument(token, source);
        document.body.appendChild(frame);
      });
    })();
    this.bridge = bridge;
    try { return await bridge; }
    catch (error) { if (this.bridge === bridge) this.bridge = undefined; throw error; }
  }

  private onReply(input: unknown) {
    const current = this.current;
    if (!current || !validReply(input, current.id)) return;
    current.events++;
    if (current.events > 3000) { this.stop('输出过于频繁，运行已停止；本章会话已重置。'); return; }
    const result = this.state.results[current.cellId];
    if (!result) return;
    switch (input.type) {
      case 'status': this.update({ message: input.message! }); break;
      case 'started': this.update({ phase: 'running', count: input.executionCount!, message: 'Python 正在运行…' }); this.patchResult(current.cellId, { executionCount: input.executionCount }); break;
      case 'chunk': {
        const stream = input.stream!;
        this.patchResult(current.cellId, { [stream]: (result[stream] + input.text).slice(0, MAX_OUTPUT) });
        break;
      }
      case 'image': if (result.images.length < 4) this.patchResult(current.cellId, { images: [...result.images, 'data:image/png;base64,' + input.data] }); break;
      case 'table': {
        const tables = safeTables([...(result.tables || []), input.table]);
        this.patchResult(current.cellId, { tables });
        break;
      }
      case 'fatal': this.stop((input.error || '运行环境加载失败。') + ' 本章会话已重置。'); break;
      case 'result': this.complete({ status: input.ok ? 'ok' : 'error', error: input.error, executionCount: input.executionCount, elapsedMs: input.elapsedMs }); break;
    }
  }
  private complete(patch: Partial<CellResult>) {
    const current = this.current;
    if (!current) return;
    clearTimeout(current.timer);
    this.current = undefined;
    this.controller = undefined;
    this.patchResult(current.cellId, patch);
    const result = this.state.results[current.cellId];
    this.update({ phase: patch.status === 'error' ? 'error' : 'ready', activeCell: undefined, count: typeof patch.executionCount === 'number' ? patch.executionCount : this.state.count, message: patch.status === 'error' ? '运行出错，可修改后重新运行' : current.runtime === 'browser' ? '本章浏览器 Python 已就绪，浏览器单元间保留变量' : current.runtime === 'gpu' ? 'GPU 会话已就绪，与普通 Python 会话独立' : this.state.environment === 'remote' ? '本章云端 Python 已就绪，普通 Python 单元共享变量' : '本章云端会话已就绪；浏览器变量不会自动带入' });
    current.finish(result);
  }
  private destroyBridge() {
    this.bridgeReject?.(new Error('运行已停止，会话已重置。'));
    const port = this.port;
    const frame = this.iframe;
    port?.postMessage({ type: 'terminate' });
    // Give the isolated frame a turn to terminate its Worker explicitly.
    setTimeout(() => { port?.close(); frame?.remove(); }, 100);
    this.port = undefined;
    this.iframe = undefined;
    this.bridge = undefined;
  }

  async execute(cell: RegisteredCell, fromBatch = false): Promise<CellResult | undefined> {
    if (this.current || (this.state.batch && !fromBatch) || !browserRunnable(cell.block)) return undefined;
    const blocked = this.unavailableReason(cell.block);
    if (blocked) {
      this.update({ message: blocked + '。可以下载本章在本机运行。' });
      return;
    }
    this.register(cell);
    const runtime: RuntimeKind = this.runtimeFor(cell.block);
    const result: CellResult = { code: cell.value, status: 'running', stdout: '', stderr: '', images: [], tables: [], runtime };
    const tooLarge = runtime === 'browser' ? cell.value.length > MAX_CODE : new TextEncoder().encode(cell.value).length > 131072;
    if (tooLarge) {
      result.status = 'error'; result.error = runtime === 'browser' ? '代码超过浏览器 160 KB 上限，请缩短后运行。' : '代码超过云端 128 KiB 上限，请缩短后运行。';
      this.update({ results: { ...this.state.results, [cell.block.id]: result } });
      return result;
    }
    const id = crypto.randomUUID();
    const generation = this.generation;
    this.update({ phase: runtime === 'browser' && !this.port ? 'loading' : 'running', activeCell: cell.block.id, message: runtime === 'browser' ? '正在启动 Python…' : '正在连接远程运行环境…', results: { ...this.state.results, [cell.block.id]: result } });
    const pending = new Promise<CellResult>(finish => {
      const timeLimit = runtime === 'browser' ? BROWSER_TIME_LIMIT : REMOTE_TIME_LIMIT;
      const timer = setTimeout(() => this.stop(`运行超过 ${timeLimit / 1000} 秒，已停止；本章会话已重置。`), timeLimit);
      this.current = { id, cellId: cell.block.id, finish, timer, events: 0, runtime };
    });
    try {
      if (runtime === 'browser') {
        const port = await this.ensureBridge();
        if (generation === this.generation && this.isCurrent(id)) port.postMessage({ type: 'execute', id, code: cell.value, filename: cell.block.filename, files: this.effectiveFiles() });
      } else {
        this.usedRemote = true;
        this.remoteKinds.add(runtime === 'gpu' ? 'gpu' : 'linux');
        this.controller = new AbortController();
        const response = await fetch('/api/runtime', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: this.controller.signal,
          body: JSON.stringify({ action: 'execute', chapterId: this.chapterId, cacheScope: this.cacheScope, code: cell.value, files: this.effectiveFiles(), cellId: cell.block.id, runtime }),
        });
        const parsed = await response.json().catch(() => ({ error: `远程运行服务响应异常（${response.status}）。` }));
        const data: Record<string, unknown> = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        if (generation !== this.generation || !this.isCurrent(id)) return pending;
        const images = remoteImages(data.images);
        this.complete({
          status: response.ok && data.status === 'ok' ? 'ok' : data.status === 'interrupted' || data.status === 'timeout' ? 'interrupted' : 'error',
          stdout: typeof data.stdout === 'string' ? data.stdout.slice(0, MAX_OUTPUT) : '',
          stderr: typeof data.stderr === 'string' ? data.stderr.slice(0, MAX_OUTPUT) : '', images, tables: safeTables(data.tables),
          error: typeof data.error === 'string' ? data.error.slice(0, 32000) : !response.ok ? `远程 ${runtime.toUpperCase()} 环境未连接（${response.status}）。` : undefined,
          executionCount: typeof data.executionCount === 'number' && Number.isSafeInteger(data.executionCount) ? data.executionCount : undefined,
          elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : undefined,
        });
        if (data.sessionLost) this.update({ count: 0, message: '远程运行已结束，会话已重置；请从头运行所需单元。' });
      }
    } catch (error) {
      if (generation === this.generation && this.isCurrent(id)) this.complete({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    return pending;
  }

  stop(message = '运行已停止；本章会话已重置，请重新运行所需单元。') {
    this.generation++;
    const remoteActive = this.current && this.current.runtime !== 'browser' ? this.current.runtime : undefined;
    const interruptedCellId = this.current?.cellId;
    const generation = this.generation;
    const displayedMessage = remoteActive ? '已停止等待结果，正在确认云端会话是否已停止…' : message;
    this.controller?.abort();
    if (remoteActive) void this.remoteAction('interrupt', remoteActive).then(ok => {
      if (generation !== this.generation || this.current) return;
      const confirmedMessage = ok ? message : '已停止等待，但未能确认云端任务已结束；重新运行前请重置。';
      if (interruptedCellId) this.patchResult(interruptedCellId, { error: confirmedMessage });
      this.update({ message: confirmedMessage });
    });
    this.complete({ status: 'interrupted', error: displayedMessage });
    this.destroyBridge();
    this.update({ phase: 'idle', batch: false, batchProgress: undefined, count: 0, activeCell: undefined, message: displayedMessage, results: Object.fromEntries(Object.entries(this.state.results).map(([id, result]) => [id, { ...result, historical: true }])) });
  }
  private async remoteAction(action: 'reset' | 'interrupt', runtime: RuntimeKind = 'linux') {
    try {
      const response = await fetch('/api/runtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, chapterId: this.chapterId, cacheScope: this.cacheScope, runtime }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) return false;
      const data = await response.json() as { status?: string };
      return ['ok', 'idle', 'interrupted'].includes(data.status || '');
    } catch { return false; }
  }
  async reset(cells = this.getCells()): Promise<boolean> {
    this.stop('本章会话已重置，变量已清空。');
    const generation = this.generation;
    for (const cell of cells) {
      if (!browserRunnable(cell.block)) continue;
      const runtime = this.runtimeFor(cell.block);
      if (runtime !== 'browser' && !this.unavailableReason(cell.block)) this.remoteKinds.add(runtime === 'gpu' ? 'gpu' : 'linux');
    }
    if (this.usedRemote || this.remoteKinds.size) {
      this.update({ batch: true, message: '正在重置远程环境…' });
      const ok = (await Promise.all([...this.remoteKinds].map(runtime => this.remoteAction('reset', runtime)))).every(Boolean);
      if (generation !== this.generation) return false;
      if (!ok) {
        this.update({ batch: false, message: '浏览器会话已重置；远程环境未连接，无法确认远程重置。' });
        return false;
      }
      this.update({ batch: false, message: '本章会话已重置，变量已清空。' });
    }
    return true;
  }
  getPrecedingCells(cellId: string) {
    const cells = this.getCells();
    const target = cells.findIndex(cell => cell.block.id === cellId);
    return target < 0 ? [] : cells.slice(0, target).filter(cell => browserRunnable(cell.block));
  }

  async runBefore(cellId: string) {
    return this.runSequence(this.getPrecedingCells(cellId), cellId);
  }

  async runAll() {
    return this.runSequence(this.getCells().filter(cell => browserRunnable(cell.block)));
  }

  private async runSequence(cells: RegisteredCell[], targetCell?: string) {
    if (this.current || this.state.batch) return;
    if (!cells.length) { this.update({ message: targetCell ? '这个单元前没有可运行的前置单元。' : '本章暂时没有可运行的 Python 单元。' }); return; }
    const blocked = this.sequenceUnavailable(cells);
    if (blocked) {
      this.update({ message: blocked + '。顺序执行未开始，当前变量和结果已保留。' });
      return;
    }
    const label = targetCell ? '前置单元' : '本章';
    const resetting = this.reset(cells);
    const generation = this.generation;
    this.update({ batch: true, batchProgress: { completed: 0, total: cells.length, targetCell }, message: `正在重置环境并运行${label}…` });
    const resetOk = await resetting;
    if (generation !== this.generation) return;
    if (!resetOk && cells.some(cell => this.runtimeFor(cell.block) !== 'browser')) {
      this.update({ batch: false, batchProgress: undefined, message: '远程重置未成功，已暂停从头运行。' });
      return;
    }
    this.update({ batch: true, message: `正在按顺序运行${label}…` });
    for (const [index, cell] of cells.entries()) {
      if (generation !== this.generation) break;
      this.update({ batchProgress: { completed: index, total: cells.length, targetCell }, message: `正在运行${label} ${index + 1} / ${cells.length}…` });
      const result = await this.execute(cell, true);
      if (!result || result.status !== 'ok') {
        if (generation === this.generation) this.update({ batch: false, message: `从头运行已在第 ${index + 1} 个单元处暂停，请修正后重试。` });
        return;
      }
    }
    if (generation === this.generation) this.update({ batch: false, batchProgress: { completed: cells.length, total: cells.length, targetCell }, message: targetCell ? `${cells.length} 个前置单元已按顺序执行，现在可以运行当前单元。` : `本章 ${cells.length} 个单元已按顺序运行。` });
  }

  setExportOriginals(files?: Record<string, string>) {
    this.exportOriginals = files || EMPTY_FILES;
  }

  async download(format: 'zip' | 'py' | 'ipynb') {
    const { createExperiment, loadExperimentSupport } = await import('./experiment-export.ts');
    const blob = createExperiment({
      chapterId: this.chapterId,
      cells: this.getCells().filter(cell => cell.block.type === 'code'),
      files: this.files, originals: this.exportOriginals, results: this.state.results,
      support: await loadExperimentSupport(this.chapterId),
    }, format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `零基础学AI-${this.chapterId.replace(/[^\w\u4e00-\u9fff-]/g, '-')}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
