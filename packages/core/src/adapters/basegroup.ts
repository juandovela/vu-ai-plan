/**
 * Turns the plan the app is configuring (or a basegroup.json export) into the
 * snapshot the analysis works on.
 *
 * This is the only place that knows the shape of a basegroup. The rules and
 * the tools only see the snapshot, so a change in how plans are stored is a
 * change here and nowhere else.
 */

import type { PlanItem, PlanRect, PlanSnapshot } from '../contract';
import { decodeTargetId } from '../rules/decodeTargetId';
import { mergeLabels } from '../rules/labels';
import { normalizeKey } from '../rules/ruleHelpers';
import { DEFAULT_GLOSSARY } from '../rules/ruleSuggestions';
import type { IFElevationInfo, IFLogicAssistItem, IFLogicAssistRect, IFRuleContext } from '../rules/types';

/** The part of a floor (layout entry) that is used. */
export interface BasegroupFloor {
  uid: string;
  name: string;
  floorNumber?: number;
}

/**
 * An asset is a base (floor), an option or an elevation. Options and
 * elevations can be children of a base or of an elevation group.
 */
export function findAssetInAssets(assets: any[], uid: string): any {
  let match: any;

  assets.forEach(asset => {
    if (match) {
      return;
    }

    if (asset.uid === uid) {
      match = asset;
    }

    if (Array.isArray(asset.children)) {
      asset.children.forEach((child: any) => {
        if (child.uid === uid) {
          match = child;
        }
      });
    }
  });

  return match;
}

/**
 * Options and the structure items that come with the plan are analysed,
 * floors and nested floor items are not.
 */
export function toAssistItems(
  listItems: any[],
  layout: BasegroupFloor[],
  assets: any[]
): IFLogicAssistItem[] {
  return listItems
    .filter(listItem => listItem.type === 'option' || listItem.type === 'structure')
    .map(listItem => {
      const asset = findAssetInAssets(assets, listItem.assetUid);
      const isOption = asset && asset.assetType === 'option';

      return {
        uid: listItem.uid,
        kind: listItem.type as 'option' | 'structure',
        name: listItem.assetName,
        originalName: decodeTargetId(listItem.targetID),
        floor: layout.find(floor => floor.uid === listItem.baseUid)?.name ?? null,
        floorUid: listItem.baseUid ?? null,
        filter: listItem.filter ?? [],
        logic: listItem.logic ?? [],
        parent: listItem.parent ?? [],
        package: listItem.package ?? [],
        rect: isOption ? rectOf(asset) : null,
        labels: isOption ? mergeLabels(asset.labels) : []
      };
    });
}

/**
 * Plans imported from a registry keep one drawing per option. Plans made of
 * a single svg do not, and list items there share the plan asset.
 */
function rectOf(asset: any): PlanRect | null {
  const rect = { x: asset.x, y: asset.y, w: asset.width, h: asset.height };

  return [rect.x, rect.y, rect.w, rect.h].every(
    value => typeof value === 'number' && isFinite(value)
  )
    ? rect
    : null;
}

export function buildRuleContext(assets: any[], layout: BasegroupFloor[]): IFRuleContext {
  const floorLabels: { [floorUid: string]: string[] } = {};
  const elevations: IFElevationInfo[] = [];

  assets.forEach(asset => {
    if (asset.assetType === 'base') {
      floorLabels[asset.uid] = mergeLabels(asset.labels).map(normalizeKey);
    }

    /**
     * An elevation group ("Elevation B") holds its schemes ("Scheme A"…). The
     * package is edited on each scheme, so those are what gets linked, named
     * after the group: it is the group that says which elevation they are.
     */
    if (asset.assetType === 'elevation' && Array.isArray(asset.children) && asset.children.length > 0) {
      asset.children.forEach((scheme: any) => {
        if (scheme.assetType === 'elevation') {
          elevations.push({
            uid: scheme.uid,
            name: `${asset.name} · ${scheme.name}`,
            package: scheme.package ?? []
          });
        }
      });

      return;
    }

    [asset].concat(asset.children ?? []).forEach((candidate: any) => {
      if (candidate.assetType === 'elevation') {
        elevations.push({
          uid: candidate.uid,
          name: candidate.name,
          package: candidate.package ?? []
        });
      }
    });
  });

  layout.forEach(floor => {
    floorLabels[floor.uid] = floorLabels[floor.uid] ?? [];
  });

  return { floorLabels, elevations };
}


/**
 * Everything the analysis needs from a basegroup.
 */
export function snapshotFromBasegroup(basegroup: {
  listItems: any[];
  assets: any[];
  layout: BasegroupFloor[];
}): PlanSnapshot {
  const context = buildRuleContext(basegroup.assets, basegroup.layout);

  return {
    floors: basegroup.layout.map((floor, index) => ({
      uid: floor.uid,
      name: floor.name,
      floorNumber: typeof floor.floorNumber === 'number' ? floor.floorNumber : index + 1
    })),
    items: toAssistItems(basegroup.listItems, basegroup.layout, basegroup.assets) as PlanItem[],
    elevations: context.elevations,
    floorLabels: context.floorLabels,
    sheet: null,
    glossary: DEFAULT_GLOSSARY
  };
}
