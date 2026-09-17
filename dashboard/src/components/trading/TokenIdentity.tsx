import React from 'react';
import { formatShortAddress } from '../../lib/format';
import { TokenMeta } from '../../types/dashboard';
import { CopyButton } from '../common/CopyButton';

interface TokenIdentityProps {
  mint: string;
  metadata?: TokenMeta;
  size?: 'sm' | 'md' | 'lg';
  showCopy?: boolean;
}

export const TokenIdentity: React.FC<TokenIdentityProps> = ({
  mint,
  metadata,
  size = 'md',
  showCopy = true,
}) => {
  const symbol = metadata?.symbol || mint.substring(0, 5).toUpperCase();
  const name = metadata?.name || 'Token';
  const imgUrl = metadata?.imageUrl;

  const isSmall = size === 'sm';
  const avatarSize = isSmall ? 24 : size === 'lg' ? 40 : 32;

  return (
    <div className="token-identity-root">
      <div
        className="token-avatar"
        style={{ width: avatarSize, height: avatarSize, minWidth: avatarSize }}
      >
        {imgUrl ? (
          <img src={imgUrl} alt={symbol} className="avatar-img" />
        ) : (
          <div className="avatar-fallback">{symbol.substring(0, 2)}</div>
        )}
      </div>

      <div className="token-info">
        <div className="token-headline">
          <span className="token-sym">${symbol}</span>
          <span className="token-name" title={name}>
            ({name})
          </span>
        </div>

        <div className="token-subline mono">
          <span>{formatShortAddress(mint, 4, 4)}</span>
          {showCopy && <CopyButton text={mint} size={10} />}
        </div>
      </div>
    </div>
  );
};
