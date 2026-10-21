/**
 * Names the ported rules use, mapped to the contract types.
 */

import type {
  Confidence,
  Finding,
  Operation,
  PlanElevation,
  PlanItem,
  PlanRect,
  PlanSheet,
  SheetOption,
  Source
} from '../contract';

export type IFLogicAssistItem = PlanItem;
export type IFLogicAssistRect = PlanRect;
export type IFElevationInfo = PlanElevation;
export type IFPlanSheet = PlanSheet;
export type IFSheetOption = SheetOption;
export type IFSheetFinding = Finding;
export type LogicAssistOp = Operation;
export type LogicAssistConfidence = Confidence;
export type LogicAssistSource = Source;

export interface IFRuleContext {
  /** Normalised room names each floor draws, by floor uid. */
  floorLabels: { [floorUid: string]: string[] };
  elevations: IFElevationInfo[];
}
