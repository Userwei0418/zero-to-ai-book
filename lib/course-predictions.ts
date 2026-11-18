import type { CourseBlock, CoursePrediction } from './course-types';
import type { CellResult } from './notebook-runtime';

type PredictionPlacement = CoursePrediction & { id: string; afterBlockId: string };
const counts = (values: number[], unit: string) => values.map(value => ({ value: String(value), label: `${value} ${unit}` }));

export const coursePredictions: Record<string, PredictionPlacement[]> = {
  'upper-01': [
    {
      id: 'upper-01-predict-first-exam', afterBlockId: 'upper-01-1f2b91683c09', cellId: 'upper-01-a4b857d7c325',
      question: '六句里，这版规则能答对几句？', options: counts([2, 3, 6], '句'), observation: 'exam', denominator: 6,
      reflect: '找一句答错的话。它的意思变了，还是它换了个说法？', challenge: '在 exam.py 里把一句话换一种说法，保留它的标准答案。预测得分，再跑一次。',
    },
    {
      id: 'upper-01-predict-first-patch', afterBlockId: 'upper-01-b5e548567999', cellId: 'upper-01-f99898cb545d',
      question: '补上“两个词都有”的规则后，六句能答对几句？', options: counts([3, 4, 6], '句'), observation: 'exam', denominator: 6,
      reflect: '两句同时提到账号和安装的话，分别想办哪件事？对照输出里给它们分的类。', challenge: '把这条补丁的返回值改成“账号申请”。先猜哪两行会变，再运行。',
    },
    {
      id: 'upper-01-predict-second-patch', afterBlockId: 'upper-01-dc0da92e14b3', cellId: 'upper-01-9cd05d4468bb',
      question: '排除“已经办完”的事后，原来六句能答对几句？', options: counts([3, 4, 6], '句'), observation: 'exam', denominator: 6,
      reflect: '分开看原题和新问题的输出，哪一种表达还会穿过这组规则？', challenge: '给新问题换一个表示“已经办完”的说法，保留原来的意图，试试规则还能否识别。',
    },
  ],
  'upper-02': [{
    id: 'upper-02-predict-training', afterBlockId: 'upper-02-6422c9129cbb', cellId: 'upper-02-7769527b5812',
    question: '楼梯灯练到 1000 轮，最后一轮的错题会比练 20 轮时怎样？',
    options: [{ value: 'less', label: '更少' }, { value: 'same', label: '一样多' }, { value: 'more', label: '更多' }],
    observation: 'training-errors', reflect: '把楼梯灯和另外两门的输出并排看。多练能解决哪一种错？',
    challenge: '把楼梯灯四个标签中的一个翻转，再跑这三门功课。试着用纸画出新的分界线。',
  }],
  'upper-06': [{
    id: 'upper-06-predict-verifier', afterBlockId: 'upper-06-5cdf8c079ee7', cellId: 'upper-06-89b4d8034d1a',
    question: '把四件事全都排队办，核对程序会怎么判？',
    options: [{ value: 'pass', label: '通过' }, { value: 'fail', label: '报错' }],
    observation: 'schedule', reflect: '把“排队办”和“同时办”放在一起看。核对通过能说明它最快吗？',
    challenge: '让“排队办”里的安装提前一分钟，保持安装时长。猜猜程序会指出哪一项。',
  }],
  'upper-13': [{
    id: 'upper-13-predict-delivery', afterBlockId: 'upper-13-03a0fcc35b98', cellId: 'upper-13-4302446cf890',
    question: '同一条通知送两遍，加了四道检查，账本会记几回？',
    options: counts([0, 1, 2], '回'), observation: 'duplicate-delivery',
    reflect: '同一组通知交给两种处理方式，哪几条账目重复了？看两条通知的 id。',
    challenge: '只改第二条通知的 id，保留办事内容。猜猜账本会记几回，再运行。',
  }],
};

export function withCoursePredictions(chapterId: string, blocks: CourseBlock[]): CourseBlock[] {
  const activities = coursePredictions[chapterId];
  if (!activities?.length) return blocks;
  const available = new Set(blocks.map(block => block.id));
  return blocks.flatMap(block => [block, ...activities.filter(activity => activity.afterBlockId === block.id && available.has(activity.cellId) && !available.has(activity.id)).map(({ id, afterBlockId: _after, ...prediction }) => ({ id, type: 'prediction' as const, text: prediction.question, prediction }))]);
}

export type PredictionComparison = {
  kind: 'waiting' | 'running' | 'stale' | 'historical' | 'failed' | 'unrecognized' | 'actual';
  badge: string; message: string; score?: number; denominator?: number; matches?: boolean;
};

type Observation = { value: string; display: string; score?: number; denominator?: number };

// Require one unambiguous reading from the named experiment; edited programs may print something else.
function observe(exercise: CoursePrediction, stdout: string): Observation | undefined {
  if (exercise.observation === 'exam') {
    const scores = [...stdout.matchAll(/^\s*(\d+)\s*\/\s*(\d+)\s*$/gm)]
      .filter(score => Number(score[2]) === exercise.denominator && Number(score[1]) <= Number(score[2]));
    if (scores.length !== 1) return;
    const score = Number(scores[0][1]);
    return { value: String(score), display: `${score}/${exercise.denominator}`, score, denominator: exercise.denominator };
  }
  if (exercise.observation === 'training-errors') {
    const rows = [...stdout.matchAll(/^楼梯灯｜练 (20|1000) 轮：最后一轮错 (\d+) 题\s*$/gm)];
    const earlier = rows.filter(row => row[1] === '20'), later = rows.filter(row => row[1] === '1000');
    if (earlier.length !== 1 || later.length !== 1) return;
    const a = Number(earlier[0][2]), b = Number(later[0][2]);
    return { value: b < a ? 'less' : b > a ? 'more' : 'same', display: `错题 ${a} → ${b}` };
  }
  if (exercise.observation === 'schedule') {
    const rows = stdout.split('\n').filter(line => /^排队办\s/.test(line));
    if (rows.length !== 1) return;
    const success = rows[0].match(/^排队办\s+\(None, (\d+)\)\s*$/);
    if (success) return { value: 'pass', display: `通过 · ${success[1]} 分钟` };
    if (/^排队办\s+\((['"]).+\1, None\)\s*$/.test(rows[0])) return { value: 'fail', display: '排队办未通过' };
    return;
  }
  const sections = [...stdout.matchAll(/^【同一条通知送来了两遍】\s*\n([^【]*)(?=^【|$)/gm)];
  if (sections.length !== 1) return;
  const rows = [...sections[0][1].matchAll(/^[ \t]*多四道检查：办了 (\d+) 回(?:：.*)?[ \t]*$/gm)];
  if (rows.length !== 1) return;
  return { value: rows[0][1], display: `记了 ${rows[0][1]} 回` };
}

/** Only a successful execution with unchanged inputs can support a comparison. */
export function comparePrediction(exercise: CoursePrediction, choice: string, code: string, result?: CellResult): PredictionComparison {
  if (!result) return { kind: 'waiting', badge: choice ? '已选预测' : '先猜一猜', message: choice ? '运行实验，看看结果是否和你想的一样。' : '选一个答案，再运行实验。也可以直接运行。' };
  if (result.status === 'running') return { kind: 'running', badge: '实验运行中', message: '正在执行，完成后可对照结果。' };
  if (result.historical) return { kind: 'historical', badge: '上次的输出', message: '重新运行即可对照当前预测。' };
  if (result.code !== code || result.inputsChanged) return { kind: 'stale', badge: '修改后待运行', message: '代码或关联文件已修改，请重新运行。' };
  if (result.status !== 'ok') return { kind: 'failed', badge: result.status === 'interrupted' ? '已停止' : '运行出错', message: result.status === 'interrupted' ? '实验已停止，可以修改后再试。' : '实验执行出错，展开实验可查看完整报错。' };
  const actual = observe(exercise, result.stdout);
  if (!actual) return { kind: 'unrecognized', badge: '查看运行输出', message: '输出格式已变化或包含多次结果，请在实验中查看这次的完整输出。' };
  const selected = exercise.options.find(option => option.value === choice);
  const matches = selected ? selected.value === actual.value : undefined;
  return { kind: 'actual', badge: `实测 ${actual.display}`, score: actual.score, denominator: actual.denominator, matches,
    message: selected ? `预测「${selected.label}」，实测「${actual.display}」。${matches ? '与你的判断一致。' : '和你预想的不同。'}` : `本次实测：${actual.display}。` };
}
