import type { TestComponentItem } from './entities';

export interface GradingEvaluation {
  score: number;
  passed: boolean;
}

// Server-side authoritative counterpart of incore-app's
// src/shared/utils/testGrading.ts — keep both in sync. The frontend's copy
// only drives an instant client-side preview while typing; this is what
// actually gets persisted by adminRecordTestAttempt.ts.
const PASS_SCORE = 60;

const clampScore = (score: number) => Math.max(0, Math.min(100, Math.round(score)));

function evaluateSimple(component: TestComponentItem, rawValue: number): GradingEvaluation {
  const { passingThreshold, excellenceThreshold } = component.grading;
  if (passingThreshold == null || excellenceThreshold == null) return { score: 0, passed: false };

  const passed = component.higherIsBetter ? rawValue >= passingThreshold : rawValue <= passingThreshold;
  if (!passed) return { score: 0, passed: false };

  const span = excellenceThreshold - passingThreshold;
  if (span === 0) return { score: 100, passed: true };

  const progress = Math.max(0, Math.min(1, (rawValue - passingThreshold) / span));
  return { score: clampScore(PASS_SCORE + progress * (100 - PASS_SCORE)), passed: true };
}

function evaluateMatrix(component: TestComponentItem, rawValue: number): GradingEvaluation {
  const bands = component.grading.bands ?? [];
  // Each band is an independent inclusive [min,max] range (either bound
  // unbounded when null) — this is what lets two separate ranges (e.g.
  // under X and over Y) both score 100 with a worse range in between,
  // without any higher-is-better direction assumption.
  const match = bands.find((b) => (b.min == null || rawValue >= b.min) && (b.max == null || rawValue <= b.max));
  return match ? { score: clampScore(match.score), passed: match.passing } : { score: 0, passed: false };
}

export function evaluateComponent(component: TestComponentItem, rawValue: number): GradingEvaluation {
  if (!Number.isFinite(rawValue)) return { score: 0, passed: false };
  return component.grading.mode === 'simple' ? evaluateSimple(component, rawValue) : evaluateMatrix(component, rawValue);
}
