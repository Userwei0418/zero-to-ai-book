import type { CourseBlock } from './course-types';

export function isSampleOutput(block: CourseBlock) {
  return block.predictionSample === true;
}

// Only fold a printed answer that belongs to a prediction. Other course examples
// can be diagrams, configuration or source text that is needed to read the page.
export function markPredictionSamples(blocks: CourseBlock[]): CourseBlock[] {
  let target: string | undefined;
  return blocks.map(block => {
    if (block.type === 'prediction') {
      target = block.prediction?.cellId;
    } else if (target && block.id !== target) {
      target = undefined;
      if (block.type === 'code' && !block.runnable && block.reason === '原文示例输出，用于对照实验结果。') {
        return { ...block, predictionSample: true };
      }
    }
    return block;
  });
}
