import { Check, Copy } from 'lucide-react';
import React, { useState } from 'react';

interface CopyButtonProps {
  text: string;
  label?: string;
  size?: number;
}

export const CopyButton: React.FC<CopyButtonProps> = ({ text, label, size = 12 }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className="btn-copy"
      onClick={handleCopy}
      title={copied ? 'Copied to clipboard' : `Copy ${text}`}
    >
      {copied ? <Check size={size} color="#10b981" /> : <Copy size={size} />}
      {label && <span style={{ marginLeft: 4 }}>{copied ? 'Copied' : label}</span>}
    </button>
  );
};
