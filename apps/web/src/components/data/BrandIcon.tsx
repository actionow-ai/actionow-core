import type { CSSProperties } from 'react';

import { ProviderIcon } from './ProviderIcon';

/**
 * Renders a selectable brand icon by its seeded `icon_asset.key` (catalog
 * icon system). Resolution: the first non-empty candidate in
 * `[icon, ...fallbacks]` is handed to {@link ProviderIcon}, which maps it to a
 * real vendor logo via its brand registry (or a monogram tile when unknown).
 *
 * A model with no own `icon` therefore inherits its channel's / plugin's icon
 * by passing them as `fallbacks` (e.g. `<BrandIcon icon={model.icon}
 * fallbacks={[channel.icon, plugin.icon, providerType]} />`).
 */
export function BrandIcon({
  icon,
  fallbacks = [],
  size = 22,
  tile = true,
  showLabel = false,
  style,
}: {
  icon?: string | null;
  /** Ordered fallback icon keys (e.g. channel icon, plugin icon, provider_type). */
  fallbacks?: (string | null | undefined)[];
  size?: number;
  tile?: boolean;
  showLabel?: boolean;
  style?: CSSProperties;
}) {
  const key = [icon, ...fallbacks].find((k) => k != null && k.trim() !== '') ?? '';
  return (
    <ProviderIcon provider={key} size={size} tile={tile} showLabel={showLabel} style={style} />
  );
}
