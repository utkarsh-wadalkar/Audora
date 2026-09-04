'use client';

import type { ComponentProps } from 'react';

type CtaLinkProps = ComponentProps<'a'> & {
  trackingId: string;
  intent: 'download' | 'github' | 'setup';
  platform?: 'windows' | 'linux-deb' | 'linux-appimage';
};

/** Emits a local event only. No analytics service, cookies, or network calls. */
export function CtaLink({ trackingId, intent, platform, children, ...props }: CtaLinkProps) {
  function track() {
    window.dispatchEvent(new CustomEvent('audora:cta', {
      detail: { id: trackingId, intent, platform: platform ?? null, href: props.href },
    }));
  }

  return <a {...props} id={trackingId} data-cta={trackingId} data-intent={intent}
    data-platform={platform} onClick={track} onAuxClick={event => { if (event.button === 1) track(); }}>
    {children}
  </a>;
}
