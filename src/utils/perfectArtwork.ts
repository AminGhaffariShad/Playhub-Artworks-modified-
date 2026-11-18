import { artworkPayloadUrl, readArtworkPayload } from './artworkTransfer';
import { call } from '@decky/api';

import { ASSET_TYPE } from '../constants';
import { clearSteamArtworkSafely, runSteamArtworkTransaction } from './derivedCover';
import getCurrentSteamUserId from './getCurrentSteamUserId';
import { hideLogo, readLogoPosition, resetLogoPosition, showLogo, writeLogoPosition } from './logoControl';
import { normalizeArtworkPayload } from './normalizeArtworkPayload';
import { isRuntimeActive } from './runtimeLifecycle';

export type PerfectTarget = 'hero' | 'grid_l';

const key = (appId: number, target: PerfectTarget) => `perfect_${target}_${appId}`;

const withTimeout = async <T>(operation: Promise<T>, timeout = 4000): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('PA_ERROR_OPERATION_TIMEOUT')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

const safeCall = async <T>(fallback: T, method: string, ...args: any[]): Promise<T> => {
  try {
    return await withTimeout(call<any, T>(method, ...args));
  } catch (_) {
    return fallback;
  }
};

type PerfectSourceSave = {
  saved?: boolean;
  existing?: boolean;
  source?: string;
};

const sourceReads = new Map<string, Promise<string>>();
const sourceWrites = new Map<string, Promise<PerfectSourceSave>>();

/**
 * The untouched artwork a Perfect composition was built from.
 * Kept once, so re-editing never composes on top of an already composed picture.
 */
export const getPerfectSource = async (appId: number, target: PerfectTarget): Promise<string> => {
  const id = key(appId, target);
  const pending = sourceReads.get(id);
  if (pending) return pending;

  const read = (async () => {
    try {
      const payload = await readArtworkPayload('', { perfectSource: { appId, target }, staticOnly: true });
      return payload ? artworkPayloadUrl(payload) : '';
    } catch (_) { return ''; }
  })();

  sourceReads.set(id, read);
  try {
    return await read;
  } finally {
    if (sourceReads.get(id) === read) sourceReads.delete(id);
  }
};

export const savePerfectSource = async (appId: number, target: PerfectTarget, data: string, ext: string) =>
  safeCall({ saved: false }, 'save_perfect_source', appId, target, data, ext);

export const preservePerfectSource = async (
  appId: number,
  target: PerfectTarget,
  candidates: string[],
  allowCustom: boolean
): Promise<PerfectSourceSave> => {
  const id = key(appId, target);
  const pending = sourceWrites.get(id);
  if (pending) return pending;

  const write = withTimeout(
    call<[number, PerfectTarget, string[], boolean], PerfectSourceSave>(
      'preserve_perfect_source',
      appId,
      target,
      candidates,
      allowCustom
    ),
    25_000
  ).catch(() => ({ saved: false }));

  sourceWrites.set(id, write);
  try {
    return await write;
  } finally {
    if (sourceWrites.get(id) === write) sourceWrites.delete(id);
  }
};

export const isPerfectArtwork = async (appId: number, target: PerfectTarget): Promise<boolean> =>
  Boolean(await safeCall(false, 'get_setting', key(appId, target), false));

// Legacy compositions have no withLogo metadata. Keep their separate logo hidden
// until they are removed, so a remaining baked logo is not drawn twice.
const hasPerfectLogoComposition = async (appId: number): Promise<boolean> => {
  for (const target of ['hero', 'grid_l'] as PerfectTarget[]) {
    if (!await safeCall(true, 'get_setting', key(appId, target), false)) continue;
    const info = await safeCall<{ withLogo?: boolean } | null>(null, 'get_setting', `perfect_${target}_info_${appId}`, null);
    if (info?.withLogo !== false) return true;
  }
  return false;
};

/**
 * A Perfect composition already carries the logo, so Steam's separate logo layer is
 * switched off to avoid showing it twice.
 */
export const markPerfectArtwork = async (appId: number, target: PerfectTarget, withLogo: boolean) => {
  /*
    Hide Steam's separate layer before marking the operation complete. The old order could
    remain forever on a stalled settings write and never reach `hideLogo`, even though the
    composed hero had already been applied.
  */
  const logoHidden = withLogo ? await hideLogo(appId) : false;
  await safeCall(false, 'set_setting', key(appId, target), true);
  await safeCall(false, 'set_setting', `perfect_${target}_info_${appId}`, { version: 118, origin: 'manual', withLogo });
  if (withLogo) return logoHidden;
  // Another Perfect artwork may still carry the logo after this one drops it.
  if (await hasPerfectLogoComposition(appId)) return await hideLogo(appId);
  await showLogo(appId);
  return false;
};

export interface PerfectHeroRestorePlan {
  exists: boolean;
  hero_action?: 'set' | 'clear';
  hero_path?: string;
  logo_action?: 'set' | 'clear' | 'keep';
  logo_path?: string;
  logo_position?: LogoPosition | null;
}

/**
 * Snapshot the currently applied hero, logo, and logo size/position before
 * applying a Perfect Hero, so "Restore Hero" can bring all three back intact.
 */
export const backupPerfectHeroState = async (appId: number, overwrite = false): Promise<boolean> => {
  let steamUser = '';
  try { steamUser = getCurrentSteamUserId(); } catch (_) { /* Backend resolves active user. */ }
  let currentPosition: LogoPosition | null = null;
  try {
    const pos = await readLogoPosition(appId);
    if (pos && pos.nWidthPct > 0.02 && pos.nHeightPct > 0.02) {
      currentPosition = pos;
    }
  } catch (_) { /* Backend falls back to grid/<appid>.json or stored backup. */ }

  const res = await safeCall<{ saved?: boolean }>(
    { saved: false },
    'backup_perfect_hero_state',
    appId,
    steamUser,
    currentPosition,
    overwrite
  );
  return Boolean(res?.saved);
};

export const hasPerfectHeroBackup = async (appId: number): Promise<boolean> => {
  const info = await safeCall<{ exists?: boolean }>(
    { exists: false },
    'get_perfect_hero_backup_info',
    appId
  );
  return Boolean(info?.exists);
};

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const applyLocalBackupAsset = async (appId: number, assetType: SGDBAssetType, path: string): Promise<void> => {
  const payload = await readArtworkPayload(path, { path: true });
  if (!payload?.data) throw new Error('PA_ERROR_RETRIEVE_ASSET');
  const normalized = await normalizeArtworkPayload(payload);
  await runSteamArtworkTransaction(async (mutate) => {
    if (!isRuntimeActive()) throw new DOMException('Aborted', 'AbortError');
    await mutate(
      'Clear artwork timeout',
      () => SteamClient.Apps.ClearCustomArtworkForApp(appId, ASSET_TYPE[assetType]),
    );
    await delay(180);
    await mutate(
      'Set artwork timeout',
      () => SteamClient.Apps.SetCustomArtworkForApp(
        appId,
        normalized.data,
        normalized.format,
        ASSET_TYPE[assetType],
      ),
    );
  });
};

/**
 * Restore the exact hero, logo, and logo size & position that were applied
 * before the Perfect Hero was created.
 */
export const restorePerfectHero = async (appId: number): Promise<boolean> => {
  const plan = await safeCall<PerfectHeroRestorePlan>(
    { exists: false },
    'prepare_perfect_hero_restore_payload',
    appId
  );
  if (!plan?.exists) return false;

  // 1. Restore pre-Perfect-Hero hero
  if (plan.hero_action === 'set' && plan.hero_path) {
    await applyLocalBackupAsset(appId, 'hero', plan.hero_path);
  } else if (plan.hero_action === 'clear') {
    await clearSteamArtworkSafely(appId, ASSET_TYPE.hero);
  }

  // 2. Restore pre-Perfect-Hero logo
  if (plan.logo_action === 'set' && plan.logo_path) {
    await applyLocalBackupAsset(appId, 'logo', plan.logo_path);
  } else if (plan.logo_action === 'clear') {
    await clearSteamArtworkSafely(appId, ASSET_TYPE.logo);
  }

  // 3. Restore pre-Perfect-Hero logo size and position
  await safeCall(false, 'set_setting', `logo_hidden_${appId}`, false);
  await safeCall(false, 'set_setting', `logo_visible_${appId}`, true);
  if (plan.logo_position && plan.logo_position.pinnedPosition) {
    await writeLogoPosition(appId, plan.logo_position);
  } else {
    await resetLogoPosition(appId);
  }

  // 4. Clean up Perfect Hero markers and backup
  sourceReads.delete(key(appId, 'hero'));
  sourceWrites.delete(key(appId, 'hero'));
  await safeCall(false, 'complete_perfect_hero_restore', appId);
  return true;
};

/** Back to Steam's own artwork plus the separate logo. */
export const clearPerfectArtwork = async (appId: number, target: PerfectTarget) => {
  sourceReads.delete(key(appId, target));
  sourceWrites.delete(key(appId, target));
  await safeCall(false, 'delete_setting', key(appId, target));
  await safeCall(false, 'clear_perfect_source', appId, target);
  await safeCall(false, 'delete_setting', `perfect_${target}_info_${appId}`);
  if (target === 'hero') {
    await safeCall(false, 'delete_setting', `zazamastro_hero_${appId}`);
    await safeCall(false, 'delete_setting', `manual_zazamastro_hero_${appId}`);
    await safeCall(false, 'clear_perfect_hero_backup', appId);
  }
  if (!await hasPerfectLogoComposition(appId)) await showLogo(appId);
};
