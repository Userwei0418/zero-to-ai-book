/* Pinned, real CPython/WASM runtime. Runs only inside an opaque-origin sandbox. */
(() => {
  'use strict';
  const INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
  const MAX_CODE = 160000;
  const MAX_TEXT = 131072;
  const MAX_IMAGE = 2800000;
  const emit = self.postMessage.bind(self);
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let python;
  let helpers;
  let userGlobals;
  let active = null;
  let count = 0;
  let textBytes = 0;
  let truncated = false;
  let loadedFiles = Object.create(null);
  let tableCount = 0;
  let tableChars = 0;

  function send(type, data = {}) {
    if (active) emit({ type, id: active, ...data });
  }
  function output(stream, text) {
    if (!active || !text) return;
    const remaining = MAX_TEXT - textBytes;
    if (remaining <= 0) {
      if (!truncated) {
        truncated = true;
        send('chunk', { stream: 'stderr', text: '\n[输出超过 128 KB，后续内容已截断。]\n' });
      }
      return;
    }
    const safe = String(text).slice(0, remaining);
    textBytes += safe.length;
    for (let offset = 0; offset < safe.length; offset += 8192) {
      send('chunk', { stream, text: safe.slice(offset, offset + 8192) });
    }
  }
  async function boot() {
    if (python) return;
    send('status', { message: '首次正在下载 Python 运行环境…' });
    importScripts(INDEX + 'pyodide.js');
    python = await self.loadPyodide({ indexURL: INDEX });
    python.setStdout({ write: (buffer) => { output('stdout', stdoutDecoder.decode(buffer, { stream: true })); return buffer.length; } });
    python.setStderr({ write: (buffer) => { output('stderr', stderrDecoder.decode(buffer, { stream: true })); return buffer.length; } });
    python.setStdin({ error: true });
    helpers = python.runPython('dict()');
    helpers.set('_emit_table_json', (json) => {
      if (tableCount >= 4 || tableChars + json.length > MAX_TEXT) { output('stderr', '[表格输出超过上限，后续表格未显示。]\n'); return; }
      tableCount++; tableChars += json.length;
      send('table', { table: JSON.parse(json) });
    });
    python.runPython(`
import os, sys, json, builtins, importlib, io, base64
os.environ['MPLBACKEND'] = 'Agg'
sys.dont_write_bytecode = True
def unavailable_input(prompt=''):
    if prompt:
        print(prompt, end='', flush=True)
    raise RuntimeError('本练习不支持交互式 input()；请将输入值写成变量后运行。')
builtins.input = unavailable_input

def _table_payload(value, columns=None):
    if columns is not None and not isinstance(columns, (list, tuple)):
        raise TypeError('columns 必须是列名列表或元组。')
    truncated = False
    if type(value).__module__.split('.')[0] == 'pandas' and hasattr(value, 'columns') and hasattr(value, 'iloc'):
        raw_columns = ['索引'] + [str(column) for column in value.columns]
        raw_rows = [[str(index)] + list(row) for index, row in zip(value.index[:100], value.iloc[:100, :19].itertuples(index=False, name=None))]
        truncated = len(value) > 100 or len(raw_columns) > 20
    elif isinstance(value, (list, tuple)) and value and all(isinstance(row, dict) for row in value[:100]):
        keys = list(dict.fromkeys(key for row in value[:100] for key in row))
        raw_columns = columns if columns is not None else keys
        raw_rows = [[row.get(key, '') for key in keys[:20]] for row in value[:100]]
        truncated = len(value) > 100 or len(keys) > 20
    elif isinstance(value, (list, tuple)) and (not value or all(isinstance(row, (list, tuple)) for row in value[:100])):
        width = max((len(row) for row in value[:100]), default=len(columns or []))
        raw_columns = columns if columns is not None else ['列 ' + str(index + 1) for index in range(width)]
        raw_rows = [list(row[:20]) for row in value[:100]]
        truncated = len(value) > 100 or width > 20
    else:
        return None
    if columns is not None:
        if type(value).__module__.split('.')[0] == 'pandas':
            raise TypeError('DataFrame 请直接 display()；需要改列名时先修改 DataFrame.columns。')
        width = len(keys) if isinstance(value, (list, tuple)) and value and isinstance(value[0], dict) else max((len(row) for row in value), default=len(columns))
        if len(columns) != width:
            raise ValueError('columns 的数量必须与数据列数一致。')
    if not raw_columns:
        return None
    safe_columns = [str(column)[:1000] for column in raw_columns[:20]]
    safe_rows = []
    budget = 120000 - sum(len(column) for column in safe_columns)
    for row in raw_rows:
        cells = [str(item) for item in row[:len(safe_columns)]]
        truncated = truncated or any(len(cell) > 4000 for cell in cells)
        cells = [cell[:4000] for cell in cells]
        cells += [''] * (len(safe_columns) - len(cells))
        cost = len(json.dumps(cells, ensure_ascii=False))
        if cost > budget:
            truncated = True
            break
        budget -= cost
        safe_rows.append(cells)
    return {'columns': safe_columns, 'rows': safe_rows, 'truncated': truncated}

def display_table(value, columns=None):
    payload = _table_payload(value, columns)
    if payload is None:
        raise TypeError('display_table() 需要 DataFrame、字典列表或二维列表；可通过 columns 指定列名。')
    _emit_table_json(json.dumps(payload, ensure_ascii=False))

def notebook_display(*values):
    for value in values:
        payload = _table_payload(value)
        if payload is not None:
            _emit_table_json(json.dumps(payload, ensure_ascii=False))
        elif value is not None:
            print(repr(value))

def invalidate_files(changed_json):
    changed = json.loads(changed_json)
    for name, module in list(sys.modules.items()):
        filename = getattr(module, '__file__', '') or ''
        if any(filename == path or filename.startswith(path.rsplit('/', 1)[0] + '/__pycache__/') for path in changed):
            sys.modules.pop(name, None)
    importlib.invalidate_caches()

async def evaluate_cell(code, filename):
    main_globals['__file__'] = filename
    from pyodide.code import eval_code_async
    try:
        value = await eval_code_async(code, globals=main_globals, filename=filename)
        payload = _table_payload(value)
        if payload is not None:
            _emit_table_json(json.dumps(payload, ensure_ascii=False))
            return None
        return None if value is None else repr(value)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()

def capture_figures():
    if 'matplotlib.pyplot' not in sys.modules:
        return '[]'
    plt = sys.modules['matplotlib.pyplot']
    figures = []
    for number in plt.get_fignums()[:4]:
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format='png', dpi=110, bbox_inches='tight')
        payload = base64.b64encode(buffer.getvalue()).decode('ascii')
        if len(payload) <= 2800000:
            figures.append(payload)
    plt.close('all')
    return json.dumps(figures)
`, { globals: helpers });
    python.FS.mkdirTree('/home/learner');
    python.FS.chdir('/home/learner');
    python.runPython("import sys; sys.path.insert(0, '/home/learner')");
    userGlobals = python.globals;
    helpers.set('main_globals', userGlobals);
    const display = helpers.get('notebook_display');
    const displayTable = helpers.get('display_table');
    try { userGlobals.set('display', display); userGlobals.set('display_table', displayTable); }
    finally { display.destroy(); displayTable.destroy(); }
    send('status', { message: 'Python 已就绪' });
  }
  function syncFiles(files) {
    const changed = [];
    let total = 0;
    for (const [name, source] of Object.entries(files || {})) {
      if (!/^[A-Za-z0-9_\-./\u4e00-\u9fff ]+$/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) throw new Error('章节附件路径无效：' + name.slice(0, 100));
      if (typeof source !== 'string' || source.length > 1500000) throw new Error('章节附件须为小于 1.5 MB 的文本文件。');
      total += source.length;
      if (total > 1500000) throw new Error('章节文件总量超过 1.5 MB，无法在浏览器中载入。');
      if (loadedFiles[name] === source) continue;
      const path = '/home/learner/' + name;
      const dir = path.slice(0, path.lastIndexOf('/'));
      python.FS.mkdirTree(dir);
      python.FS.writeFile(path, source, { encoding: 'utf8' });
      loadedFiles[name] = source;
      changed.push(path);
    }
    for (const name of Object.keys(loadedFiles)) {
      if (!Object.prototype.hasOwnProperty.call(files || {}, name)) {
        const path = '/home/learner/' + name;
        try { python.FS.unlink(path); } catch (_) { /* already removed by the learner */ }
        delete loadedFiles[name];
        changed.push(path);
      }
    }
    if (changed.length) {
      const invalidate = helpers.get('invalidate_files');
      try { invalidate(JSON.stringify(changed)); } finally { invalidate.destroy(); }
    }
  }
  self.onmessage = async (event) => {
    const request = event.data;
    if (!request || request.type !== 'execute' || typeof request.id !== 'string' || request.id.length > 100 || typeof request.code !== 'string' || request.code.length > MAX_CODE || active) return;
    active = request.id;
    textBytes = 0;
    truncated = false;
    tableCount = 0;
    tableChars = 0;
    let executionCount;
    let failure;
    const start = performance.now();
    try {
      await boot();
      syncFiles(request.files);
      send('status', { message: '正在准备代码依赖…' });
      // Only the pinned Pyodide distribution is allowed by the iframe CSP.
      await python.loadPackagesFromImports(request.code, {
        messageCallback: (message) => send('status', { message: String(message).slice(0, 500) }),
        errorCallback: (message) => output('stderr', String(message) + '\n'),
      });
      executionCount = ++count;
      send('started', { executionCount });
      helpers.set('_cell_code', request.code);
      const courseFile = typeof request.filename === 'string' && Object.hasOwn(loadedFiles, request.filename);
      helpers.set('_cell_filename', '/home/learner/' + (courseFile ? request.filename : 'cell_' + executionCount + '.py'));
      const result = await python.runPythonAsync('await evaluate_cell(_cell_code, _cell_filename)', { globals: helpers });
      if (result !== undefined && result !== null) output('stdout', String(result) + '\n');
    } catch (error) {
      failure = String(error && error.message || error).slice(0, 32000);
    } finally {
      // A plot belongs to the cell that created it even when that cell raises.
      // Always close figures here so an old figure cannot leak into the next cell.
      if (helpers) {
        const capture = helpers.get('capture_figures');
        try {
          const images = JSON.parse(capture());
          for (const data of images) if (typeof data === 'string' && data.length <= MAX_IMAGE) send('image', { data });
        } catch (error) {
          const message = '图像输出失败：' + String(error && error.message || error).slice(0, 1000);
          if (!failure) failure = message;
          else output('stderr', message + '\n');
        } finally { capture.destroy(); }
      }
      output('stdout', stdoutDecoder.decode());
      output('stderr', stderrDecoder.decode());
      send('result', {
        ok: !failure,
        executionCount,
        elapsedMs: Math.round(performance.now() - start),
        ...(failure ? { error: failure } : {}),
      });
      active = null;
    }
  };
})();
