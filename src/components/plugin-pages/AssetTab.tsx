import { DialogButton, Focusable, ModalRoot, showModal } from '@decky/ui';
import { call, toaster } from '@decky/api';
import { useState, FC, useRef, useEffect, useCallback } from 'react';
import { MdApps, MdCropPortrait } from 'react-icons/md';

import { useSGDB } from '../../hooks/useSGDB';
import Asset from '../asset/Asset';
import t, { localizeError } from '../../utils/i18n';
import MenuIcon from '../Icons/MenuIcon';
import AssetDetailsModal from '../../modals/AssetDetailsModal';
import { SGDB_ASSET_TYPE_READABLE } from '../../constants';
import useAssetSearch from '../../hooks/useAssetSearch';
import useSettings from '../../hooks/useSettings';
import { artworkJobKey, isArtworkTargetBusy, useArtworkJobs } from '../../utils/artworkJobStore';
import { isZazaMastroAsset } from '../../utils/zazamastroBatch';
import { readArtworkPayload } from '../../utils/artworkTransfer';
import { normalizeArtworkPayload } from '../../utils/normalizeArtworkPayload';
import { backupPerfectHeroState, clearPerfectArtwork, markPerfectArtwork } from '../../utils/perfectArtwork';

const CoverStyleChoiceModal: FC<{
  closeModal?: () => void;
  gameName: string;
  onSelectStyle: (style: 'portrait' | 'square') => void;
}> = ({ closeModal, gameName, onSelectStyle }) => {
  const choose = (style: 'portrait' | 'square') => {
    closeModal?.();
    onSelectStyle(style);
  };
  return (
    <ModalRoot closeModal={closeModal}>
      <Focusable flow-children="vertical" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 4px' }}>
        <strong style={{ fontSize: 18 }}>{t('PA_ASSIGN_COVER_STYLE_TITLE', 'Assign cover style')}</strong>
        <span style={{ fontSize: 13, opacity: 0.78 }}>
          {t('PA_ASSIGN_COVER_STYLE_DESC', 'Save this cover for {gameName} as a Vertical cover or Square cover?').replace('{gameName}', gameName || '')}
        </span>
        <DialogButton onClick={() => choose('portrait')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <MdCropPortrait />
            <span>{t('PA_VERTICAL_COVER', 'Vertical cover')}</span>
          </span>
        </DialogButton>
        <DialogButton onClick={() => choose('square')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <MdApps />
            <span>{t('PA_SQUARE_COVER', 'Square cover')}</span>
          </span>
        </DialogButton>
      </Focusable>
    </ModalRoot>
  );
};

const AssetTab: FC<{ assetType: SGDBAssetType; onArtworkApplied?: () => void }> = ({ assetType, onArtworkApplied }) => {
  const { get } = useSettings();
  const {
    loading: searchLoading,
    assets,
    searchAndSetAssets,
    loadMore,
    openFilters,
    endReached,
    currentFilters,
  } = useAssetSearch();
  const { appOverview, changeAsset, changeAssetFromUrl } = useSGDB();
  const artworkJobs = useArtworkJobs();
  const [tabLoading, setTabLoading] = useState(true);
  const loading = searchLoading || tabLoading;

  const scrollRef = useRef<HTMLDivElement>(null);
  const intersectRef = useRef<HTMLDivElement>(null);

  const applyCoverForStyle = useCallback(async (asset: any, chosenStyle: 'portrait' | 'square') => {
    if (isArtworkTargetBusy(appOverview.appid, 'grid_p')) return;
    try {
      const payload = await readArtworkPayload(asset.url);
      if (!payload) {
        throw new Error(t('PA_ERROR_RETRIEVE_ASSET', 'The artwork could not be retrieved.'));
      }
      const normalized = await normalizeArtworkPayload(payload);
      const activeFormat = String(await get('library_cover_format', 'portrait')) === 'square' ? 'square' : 'portrait';
      if (activeFormat === chosenStyle) {
        await changeAsset(normalized.data, 'grid_p', normalized.format, chosenStyle);
      } else {
        await call('save_style_cover', appOverview.appid, 0, normalized.format, normalized.data, chosenStyle);
      }
      onArtworkApplied?.();
      toaster.toast({
        title: appOverview?.display_name,
        body: activeFormat === chosenStyle
          ? (chosenStyle === 'square'
            ? t('PA_SQUARE_COVER_APPLIED', 'Square cover applied!')
            : t('PA_VERTICAL_COVER_APPLIED', 'Vertical cover applied!'))
          : (chosenStyle === 'square'
            ? t('PA_SQUARE_COVER_SAVED', 'Saved as Square cover (applies when switching to Square).')
            : t('PA_VERTICAL_COVER_SAVED', 'Saved as Vertical cover (applies when switching to Portrait).')),
        icon: <MenuIcon />,
        duration: 2000,
      });
    } catch (err: any) {
      toaster.toast({
        title: t('MSG_ASSET_APPLY_ERROR', 'There was a problem applying this asset.'),
        body: localizeError(err),
        icon: <MenuIcon fill="#f3171e" />,
      });
    }
  }, [appOverview, changeAsset, get, onArtworkApplied]);

  const setAsset = useCallback(async (asset: any) => {
    if (isArtworkTargetBusy(appOverview.appid, assetType)) return;
    if (assetType === 'grid_p') {
      showModal(
        <CoverStyleChoiceModal
          gameName={appOverview?.display_name ?? ''}
          onSelectStyle={(style) => { void applyCoverForStyle(asset, style); }}
        />,
        window
      );
      return;
    }
    try {
      /*
        There is only ever one hero (and one banner) per game. Picking a new one from the
        grid therefore replaces whatever was there - including a Perfect composition and
        the untouched source it was built from - so the next edit starts from THIS artwork
        instead of quietly re-composing the old one.
      */

      const zazaHero = assetType === 'hero' && isZazaMastroAsset(asset);
      if (zazaHero) {
        await backupPerfectHeroState(appOverview.appid);
      }
      await changeAssetFromUrl(asset.url, assetType);
      // Do not discard the original/visibility state until replacement actually succeeds.
      if (assetType === 'hero' || assetType === 'grid_l') {
        await clearPerfectArtwork(appOverview.appid, assetType);
      }

      /*
        A ZazaMastro hero already has the logo painted into it, so Steam's separate
        logo layer has to go or the game page shows it twice.
      */
      if (assetType === 'hero') {
        if (zazaHero) {
          await call('set_setting', `manual_zazamastro_hero_${appOverview.appid}`, true);
          await markPerfectArtwork(appOverview.appid, 'hero', true);
        } else {
          await call('delete_setting', `manual_zazamastro_hero_${appOverview.appid}`);
        }
      }
      onArtworkApplied?.();

      toaster.toast({
        title: appOverview?.display_name,
        body: zazaHero
          ? t('PA_PERFECT_HERO_APPLIED', 'Perfect Hero applied. The separate logo has been hidden.')
          : t('MSG_ASSET_APPLY_SUCCESS', '{assetType} has been successfully applied!').replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType]),
        icon: <MenuIcon />,
        duration: zazaHero ? 2600 : 1500,
      });
    } catch (err: any) {
      toaster.toast({
        title: t('MSG_ASSET_APPLY_ERROR', 'There was a problem applying this asset.'),
        body: localizeError(err),
        icon: <MenuIcon fill="#f3171e" />,
      });
    }
  }, [appOverview, applyCoverForStyle, assetType, changeAssetFromUrl, onArtworkApplied]);

  const openDetails = useCallback((asset: any) => {
    showModal(
      <AssetDetailsModal
        asset={asset}
        assetType={assetType}
        onApply={() => setAsset(asset)}
      />,
      window
    );
  }, [assetType, setAsset]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setTabLoading(true);
      try {
        const filters = await get(`filters_${assetType}`, null);
        // Search loading is owned by the provider; an obsolete request must not pin this tab.
        if (active) void searchAndSetAssets(assetType, 0, filters);
      } finally {
        if (active) setTabLoading(false);
      }
    })();
    return () => { active = false; };
  }, [searchAndSetAssets, assetType, get]);

  useEffect(() => {
    if (!intersectRef.current || loading || endReached) return;
    const observer = new IntersectionObserver(([entry], self) => {
      if (entry.isIntersecting) {
        loadMore(assetType, (res) => {
          if (res.length === 0) self.disconnect();
        });
      }
    }, { threshold: 0, root: scrollRef.current });
    observer.observe(intersectRef.current);
    return () => observer.disconnect();
  }, [assetType, endReached, loadMore, loading]);

  if (!appOverview) return null;

  return (
    <div className="pa-results">
      <div className="pa-results-scroll" ref={scrollRef}>
        {loading ? (
          <div className="pa-inline-state">
            <img alt="" src="/images/steam_spinner.png" />
            <span>{t('PA_SEARCHING_ARTWORK', 'Searching for artwork…')}</span>
          </div>
        ) : (
          <Focusable className={`pa-grid type-${assetType}`} flow-children="grid">
            {assets.map((asset: any) => {
              const job = artworkJobs.find((item) => item.key === artworkJobKey(appOverview.appid, assetType, asset.url));
              return (
                <Asset
                  key={asset.id}
                  scrollContainer={scrollRef.current as Element}
                  author={asset.author}
                  provider={asset.provider ?? currentFilters?.provider ?? currentFilters?.providers?.[0] ?? 'steamgriddb'}
                  notes={asset.notes}
                  src={asset.thumb}
                  width={asset.width}
                  height={asset.height}
                  humor={asset.humor}
                  epilepsy={asset.epilepsy}
                  nsfw={asset.nsfw}
                  assetType={assetType}
                  isAnimated={String(asset.thumb).includes('.webm')}
                  isDownloading={job?.status === 'running'}
                  downloadProgress={job?.progress}
                  downloadStatus={job?.status}
                  onActivate={() => setAsset(asset)}
                  onOKActionDescription={t('ACTION_ASSET_APPLY', 'Apply {assetType}').replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType])}
                  onSecondaryActionDescription={t('PA_FILTERS', "Filters")}
                  onSecondaryButton={() => openFilters(assetType)}
                  onMenuActionDescription={t('ACTION_OPEN_DETAILS', 'Details')}
                  onMenuButton={() => openDetails(asset)}
                  onContextMenu={(evt: any) => {
                    evt.preventDefault();
                    openDetails(asset);
                  }}
                />
              );
            })}
            <div ref={intersectRef} style={{ gridColumn: '1 / -1', height: '4px' }} />
            {assets.length === 0 && (
              <div className="pa-empty">{t('Search_NoResults', 'No Results Found.', true)}</div>
            )}
          </Focusable>
        )}
      </div>
    </div>
  );
};

export default AssetTab;
