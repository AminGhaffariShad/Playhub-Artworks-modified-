import t, { localizeError } from '../../utils/i18n';
import { FC, useState, useEffect, useRef, useCallback } from 'react';
import { call, toaster } from '@decky/api';
import { DialogButton, Focusable } from '@decky/ui';
import { HiArrowUturnLeft, HiFolderOpen, HiTrash } from 'react-icons/hi2';

import { ASSET_TYPE } from '../../constants';
import useSGDB from '../../hooks/useSGDB';
import MenuIcon from '../Icons/MenuIcon';
import getAppOverview from '../../utils/getAppOverview';
import { clearPerfectArtwork, hasPerfectHeroBackup, isPerfectArtwork, restorePerfectHero } from '../../utils/perfectArtwork';
import openFilePicker, { isFilePickerCancelled } from '../../utils/openFilePicker';
import { artworkSources, useArtworkPreview } from '../../utils/artworkSources';
import { artworkPayloadUrl, readArtworkPayload } from '../../utils/artworkTransfer';
import { normalizeArtworkPayload } from '../../utils/normalizeArtworkPayload';
import {
  clearDerivedCoverBackup,
  clearSteamArtworkSafely,
  getDerivedCoverBackupInfo,
  restoreDerivedCover,
} from '../../utils/derivedCover';

type SlotKey = 'grid_p_portrait' | 'grid_p_square' | 'grid_l' | 'hero' | 'logo' | 'icon';

const SLOTS: Array<{ slotKey: SlotKey; assetType: SGDBAssetType; coverStyle?: 'portrait' | 'square'; title: string; hint: string }> = [
  { slotKey: 'grid_p_portrait', assetType: 'grid_p', coverStyle: 'portrait', title: t('PA_VERTICAL_COVER', 'Vertical cover'), hint: t('PA_VERTICAL_COVER_HINT', 'Portrait cover (2:3), used in portrait library mode') },
  { slotKey: 'grid_p_square', assetType: 'grid_p', coverStyle: 'square', title: t('PA_SQUARE_COVER', 'Square cover'), hint: t('PA_SQUARE_COVER_HINT', 'Square cover (1:1), used in square library mode') },
  { slotKey: 'grid_l', assetType: 'grid_l', title: t('PA_BANNER', 'Banner'), hint: t('PA_BANNER_HINT', 'Horizontal capsule') },
  { slotKey: 'hero', assetType: 'hero', title: t('PA_BACKGROUND', 'Background'), hint: t('PA_BACKGROUND_HINT', 'Game page header') },
  { slotKey: 'logo', assetType: 'logo', title: t('ASSET_TYPE_LOGO', 'Logo'), hint: t('PA_LOGO_HINT', 'Transparent, overlaid on the background') },
  { slotKey: 'icon', assetType: 'icon', title: t('ASSET_TYPE_ICON', 'Icon'), hint: t('PA_ICON_HINT', 'Square, used in lists') },
];

const AssetSlot: FC<{
  app: AppStoreAppOverview;
  assetType: SGDBAssetType;
  coverStyle?: 'portrait' | 'square';
  title: string;
  hint: string;
  browseStartPath: string;
  editable: boolean;
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}> = ({ app, assetType, coverStyle, title, hint, browseStartPath, editable, active, onActivate, onDeactivate }) => {
  const { clearAsset, changeAsset, changeAssetFromUrl } = useSGDB();
  const [overview, setOverview] = useState<AppStoreAppOverview>(app);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [derivedCover, setDerivedCover] = useState(false);
  const [restorableHero, setRestorableHero] = useState(false);
  const [stylePreview, setStylePreview] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);

  const genericPreview = useArtworkPreview(coverStyle ? [] : artworkSources(overview, assetType), reloadKey);
  const preview = coverStyle ? stylePreview : genericPreview;

  useEffect(() => {
    if (!coverStyle) {
      setStylePreview('');
      return;
    }
    let mounted = true;
    void (async () => {
      try {
        const info = await call<[number, string, string], { exists?: boolean; path?: string }>(
          'get_style_cover_info',
          app.appid,
          coverStyle,
          ''
        );
        if (!mounted) return;
        if (info?.exists && info.path) {
          const payload = await readArtworkPayload(info.path, { path: true, staticOnly: true });
          if (mounted) setStylePreview(payload ? artworkPayloadUrl(payload) : '');
        } else {
          setStylePreview('');
        }
      } catch (_) {
        if (mounted) setStylePreview('');
      }
    })();
    return () => { mounted = false; };
  }, [app.appid, coverStyle, reloadKey]);

  const refresh = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [next, backup, heroBackup, heroPerfect] = await Promise.all([
      getAppOverview(app.appid),
      assetType === 'grid_p' ? getDerivedCoverBackupInfo(app.appid) : Promise.resolve(null),
      assetType === 'hero' ? hasPerfectHeroBackup(app.appid) : Promise.resolve(false),
      assetType === 'hero' ? isPerfectArtwork(app.appid, 'hero') : Promise.resolve(false),
    ]);
    if (next) setOverview(next);
    setDerivedCover(Boolean(backup?.recoverable ?? backup?.is_derived));
    setRestorableHero(Boolean(heroBackup || heroPerfect));
    setReloadKey((value) => value + 1);
  }, [app.appid, assetType]);

  useEffect(() => {
    let active = true;
    if (assetType === 'grid_p') {
      setRestorableHero(false);
      void getDerivedCoverBackupInfo(app.appid).then((backup) => {
        if (active) setDerivedCover(Boolean(backup.recoverable ?? backup.is_derived));
      });
    } else if (assetType === 'hero') {
      setDerivedCover(false);
      void Promise.all([hasPerfectHeroBackup(app.appid), isPerfectArtwork(app.appid, 'hero')]).then(([heroBackup, heroPerfect]) => {
        if (active) setRestorableHero(Boolean(heroBackup || heroPerfect));
      });
    } else {
      setDerivedCover(false);
      setRestorableHero(false);
    }
    return () => { active = false; };
  }, [app.appid, assetType]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      if (!isFilePickerCancelled(error)) {
        toaster.toast({
          title: 'Playhub Artworks',
          body: localizeError(error),
          icon: <MenuIcon fill="#ff5d5d" />,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const browse = () => run(async () => {
    const path = await openFilePicker(browseStartPath, true, undefined, {
      validFileExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'tiff', 'tga'],
    });
    if (coverStyle) {
      const payload = await readArtworkPayload(path.path as string, { path: true });
      if (!payload) throw new Error(t('PA_ERROR_RETRIEVE_ASSET', 'The artwork could not be retrieved.'));
      const normalized = await normalizeArtworkPayload(payload);
      const activeFormat = String(await call<[string, string], string>('get_setting', 'library_cover_format', 'portrait')) === 'square' ? 'square' : 'portrait';
      if (activeFormat === coverStyle) {
        await changeAsset(normalized.data, 'grid_p', normalized.format, coverStyle);
      } else {
        await call('save_style_cover', app.appid, 0, normalized.format, normalized.data, coverStyle);
      }
      return;
    }
    // One hero, one banner: a file chosen here replaces any Perfect composition too.
    if (assetType === 'hero' || assetType === 'grid_l') {
      await clearPerfectArtwork(app.appid, assetType);
    }
    await changeAssetFromUrl(path.path as string, assetType, true);
  });

  const restorePreviousCover = () => run(async () => {
    try {
      await restoreDerivedCover(app.appid);
      toaster.toast({
        title: 'Playhub Artworks',
        body: t('PA_DERIVED_COVER_RESTORED', 'Previous cover restored.'),
        icon: <MenuIcon />,
      });
    } catch (error) {
      toaster.toast({
        title: t('PA_RESTORE_DERIVED_COVER', 'Restore previous cover'),
        body: localizeError(error, 'PA_ERROR_DERIVED_COVER_RESTORE_FAILED'),
        icon: <MenuIcon fill="#ff5d5d" />,
      });
    }
  });

  const leave = () => {
    onDeactivate();
    window.setTimeout(() => cardRef.current?.focus(), 0);
  };

  return (
    <Focusable
      ref={cardRef}
      className={`pa-slot ${active ? 'is-active' : ''}`}
      focusClassName="is-focused"
      focusWithinClassName="is-focused"
      onActivate={editable && !active ? onActivate : undefined}
      onOKActionDescription={editable && !active ? t('PA_MANAGE_ITEM', 'Manage {item}').replace('{item}', title.toLowerCase()) : undefined}
    >
      <div className="pa-slot-art">
        {preview
          ? <img className="pa-slot-image" src={preview} alt="" />
          : <span className="pa-slot-missing">{t('PA_NO_ARTWORK', "No artwork")}</span>}
      </div>

      <div className="pa-slot-copy">
        <strong>{title}</strong>
        <span>{hint}</span>
        {!editable && <span className="pa-slot-locked">{t('PA_NOT_EDITABLE_SHORTCUT', 'Not editable for this shortcut')}</span>}
      </div>

      {/*
        The buttons only exist once the card is chosen. Keeping five cards' worth of
        buttons permanently focusable made Steam scroll sideways through them and push
        the artwork behind the top bar and the footer.
      */}
      {active && editable && (
        <Focusable
          className="pa-slot-actions"
          flow-children="horizontal"
          onCancelButton={leave}
          onCancelActionDescription={t('PA_BACK_TO_CARDS', 'Back to cards')}
        >
          <DialogButton
            disabled={busy}
            onClick={browse}
            onOKActionDescription={t('PA_CHOOSE_LOCAL_FILE', 'Choose a local file')}
          >
            <HiFolderOpen /><span>{t('PA_CHOOSE_FILE', "Choose file")}</span>
          </DialogButton>
          <DialogButton
            disabled={busy}
            onClick={() => run(async () => {
              if (coverStyle) {
                await call('delete_style_cover', app.appid, coverStyle, '');
                const activeFormat = String(await call<[string, string], string>('get_setting', 'library_cover_format', 'portrait')) === 'square' ? 'square' : 'portrait';
                if (activeFormat === coverStyle) {
                  await clearSteamArtworkSafely(app.appid, ASSET_TYPE.grid_p);
                  await clearDerivedCoverBackup(app.appid);
                }
                return;
              }
              // Restoring Steam's own artwork drops the Perfect composition with it.
              if (assetType === 'hero' || assetType === 'grid_l') {
                await clearPerfectArtwork(app.appid, assetType);
              }
              if (assetType === 'icon') {
                await clearAsset(assetType);
              } else {
                await clearSteamArtworkSafely(app.appid, ASSET_TYPE[assetType]);
              }
              if (assetType === 'grid_p') await clearDerivedCoverBackup(app.appid);
            })}
            onOKActionDescription={t('PA_RESTORE_STEAM_ART', 'Restore Steam artwork')}
          >
            <HiTrash /><span>{t('PA_DELETE', "Delete")}</span>
          </DialogButton>
          {assetType === 'grid_p' && derivedCover && (
            <DialogButton
              disabled={busy}
              onClick={restorePreviousCover}
              onOKActionDescription={t('PA_RESTORE_DERIVED_COVER', 'Restore previous cover')}
            >
              <HiArrowUturnLeft /><span>{t('PA_RESTORE_DERIVED_COVER', 'Restore previous cover')}</span>
            </DialogButton>
          )}
          {assetType === 'hero' && restorableHero && (
            <DialogButton
              disabled={busy}
              onClick={() => run(async () => {
                const restored = await restorePerfectHero(app.appid);
                if (restored) {
                  toaster.toast({
                    title: 'Playhub Artworks',
                    body: t('PA_HERO_RESTORED', 'Original hero, logo, and logo position restored.'),
                    icon: <MenuIcon />,
                  });
                }
              })}
              onOKActionDescription={t('PA_RESTORE_HERO', 'Restore Hero')}
            >
              <HiArrowUturnLeft /><span>{t('PA_RESTORE_HERO', 'Restore Hero')}</span>
            </DialogButton>
          )}
        </Focusable>
      )}

      {!active && editable && (
        <span className="pa-slot-cta">{t('PA_PRESS_A_MANAGE', "Press A to manage")}</span>
      )}
    </Focusable>
  );
};

const ManageTab: FC = () => {
  const { appId, appOverview } = useSGDB();
  const [startPath, setStartPath] = useState('/');
  const [overview, setOverview] = useState<AppStoreAppOverview>();
  const [activeSlot, setActiveSlot] = useState<SlotKey | null>(null);

  useEffect(() => {
    if (!appId) return;
    (async () => {
      const appoverview = await getAppOverview(appId);
      if (!appoverview) return;
      setOverview(appoverview);
      try {
        setStartPath(await call<[], string>('get_local_start'));
      } catch (_) {
        setStartPath('/');
      }
    })();
  }, [appId, appOverview]);

  if (!overview || !appId) return null;

  const iconEditable = !(overview.third_party_mod || (overview.BIsShortcut() && overview.selected_clientid != '0'));

  return (
    <div className="pa-results">
      <div className="pa-results-scroll pa-results-scroll-slots">
        <Focusable className="pa-slots" flow-children="vertical">
          {SLOTS.map((slot) => (
            <AssetSlot
              key={slot.slotKey}
              app={overview}
              assetType={slot.assetType}
              coverStyle={slot.coverStyle}
              title={slot.title}
              hint={slot.hint}
              browseStartPath={startPath}
              editable={slot.assetType === 'icon' ? iconEditable : true}
              active={activeSlot === slot.slotKey}
              onActivate={() => setActiveSlot(slot.slotKey)}
              onDeactivate={() => setActiveSlot(null)}
            />
          ))}
        </Focusable>
      </div>
    </div>
  );
};

export default ManageTab;
