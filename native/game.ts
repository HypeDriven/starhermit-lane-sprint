// The browser build's pure game modules — the deterministic rules
// (src/rules.js: state, legality, the 60 Hz fixed step, collisions, scoring,
// hashing, the seeded stream), the versioned content (src/content.js: the 40
// stages, the Daily, the themes, the validator and reference solver), the
// session with its command log, replay envelope and replay check
// (src/session.js) and the progress document (src/progress.js) — imported
// unchanged (allowJs) and typed here with the shapes this client reads.
import * as RulesJs from "../src/rules.js";
import * as ContentJs from "../src/content.js";
import * as SessionJs from "../src/session.js";
import * as ProgressJs from "../src/progress.js";

export interface Car { row: number; lane: number; z: number; speed: number; passed: boolean; hue: number }
export interface Pad { lane: number; z: number; taken: boolean }
export interface State {
  schemaVersion: number; seed: number; stageIndex: number; tick: number; elapsed: number; lane: number; position: number; speed: number;
  boostActive: boolean; boostTimer: number; boostReadyAt: number; crashed: boolean; finished: boolean; stageLength: number; parTime: number;
  checkpointCount: number; checkpointIndex: number; cleanPasses: number; padsCollected: number; invalidActions: number; laneChanges: number;
  traffic: Car[]; pads: Pad[]; events: string[];
}
export interface Stage {
  id: string; index: number; seed: number; length: number; rowSpacing: number; doubleBlockChance: number; padChance: number;
  trafficSpeedMin: number; trafficSpeedMax: number; checkpoints: number; parTime: number; theme: string; contentVersion: number; dayKey?: string;
}
export interface Theme { id: string; sky: number; road: number; fog: number; accent: number }
export interface Breakdown { distance: number; passes: number; pads: number; timeBonus: number; finishBonus: number; total: number }
export interface Session {
  stage: Stage; state: State; accumulator: number; commandCount: number;
  replay: { commands: { tick: number; actionId: string }[]; hashes: number[] };
}
export interface Progress { highestStage: number; bestScores: Record<string, number>; dailyBest: Record<string, number> }

interface RulesApi {
  LANE_COUNT: number; DT: number; LANE_WIDTH: number; CAR_LENGTH: number;
  TUNING: { CRUISE_SPEED: number; BOOST_SPEED: number; BOOST_DURATION: number; BOOST_COOLDOWN: number };
  scoreBreakdown(s: State): Breakdown;
  progressPct(s: State): number;
  isTerminal(s: State): boolean;
  isLegalAction(s: State, a: string): boolean;
}
interface ContentApi {
  STAGE_COUNT: number;
  getStage(i: number): Stage;
  getDailyStage(utcMs: number): Stage;
  getTheme(id: string): Theme;
}
interface SessionApi {
  startSession(stage: Stage): Session;
  sendCommand(s: Session, action: string): boolean;
  advance(s: Session, seconds: number): number;
  drainEvents(s: Session): string[];
  verifyReplay(s: Session): { hash: number; matches: boolean };
}
interface ProgressApi {
  MAX_STAGE: number;
  normalize(raw: unknown): Progress;
  merge(a: unknown, b: unknown): Progress;
  readForeign(text: string | null): Progress | null;
  recordScore(doc: Progress, key: string, score: number, isDaily: boolean): boolean;
  bestScore(doc: Progress, key: string, isDaily: boolean): number;
  unlockStage(doc: Progress, index: number): number;
  nextStage(doc: Progress): number;
}

export const Rules = RulesJs as unknown as RulesApi;
export const Content = ContentJs as unknown as ContentApi;
export const Sess = SessionJs as unknown as SessionApi;
export const Prog = ProgressJs as unknown as ProgressApi;
