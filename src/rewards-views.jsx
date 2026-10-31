import React, { useState } from 'react';
import { useSignMessage } from 'wagmi';
import { arc } from './arc.js';
import { useArcNetwork } from './use-arc-network.js';
import { registerReferral } from './api.js';
import { referralAddress, referralMessage, referralShareUrl } from './referral.js';
import { NavLink } from './router.jsx';

export function Referral() {
  const { address, isConnected } = useArcNetwork();
  const { signMessageAsync } = useSignMessage();
  const referrer = referralAddress(new URLSearchParams(window.location.search).get('ref'));
  const validInvite = Boolean(referrer && (!address || referrer.toLowerCase() !== address.toLowerCase()));
  const shareUrl = address ? referralShareUrl(address, window.location.origin, import.meta.env.BASE_URL) : null;
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);

  async function copyInvite() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage('Referral link copied. Only signed wallet registrations are recorded.');
    } catch {
      setMessage('Copy the URL from the field instead.');
    }
  }

  async function acceptInvite() {
    if (!address || !validInvite || !referrer || working) return;
    setWorking(true);
    setMessage('');
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: referralMessage({ wallet: address, referrer, chainId: arc.id, issuedAt }),
      });
      const result = await registerReferral({ wallet: address, referrer, issuedAt, signature });
      setMessage(result.existing
        ? 'This wallet is already linked to the same referrer.'
        : 'Referral recorded. Reward eligibility rules will be announced separately.');
    } catch (error) {
      setMessage(error?.code === 4001 || error?.name === 'UserRejectedRequestError'
        ? 'Signature cancelled. Nothing was recorded.'
        : (error?.message ?? 'Could not save this referral. Please try again.'));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="page rewards-page">
      <div className="rewards-intro">
        <span className="eyebrow">COMMUNITY / 01</span>
        <h1>INVITE THE <mark>MEMEVERSE.</mark></h1>
        <p>Share your link with friends who want to create and trade on Arc. Referrals are recorded by wallet signature, not by clicks.</p>
      </div>
      <div className="rewards-grid">
        <article className="rewards-panel">
          <span className="eyebrow">YOUR REFERRAL LINK</span>
          <h2>Bring your crew.</h2>
          <p>Connect your wallet to generate a personal link. Your friend can then sign a free message to confirm who invited them.</p>
          <label className="referral-label" htmlFor="referral-link">SHAREABLE LINK</label>
          <div className="referral-copy">
            <input id="referral-link" readOnly value={shareUrl ?? 'Connect your wallet to generate a link'} aria-label="Your referral link" onFocus={(event) => event.target.select()} />
            <button className="btn primary" type="button" disabled={!shareUrl} onClick={copyInvite}>COPY LINK</button>
          </div>
          <p className="rewards-note">Sharing a link is free. A visit alone does not count as a verified referral.</p>
          {validInvite ? (
            <div className="referral-invite">
              <span className="eyebrow">YOU WERE INVITED BY</span>
              <strong>{referrer}</strong>
              <p>Register this referral with your connected wallet. Signing grants no spending permission and transfers no funds.</p>
              <button className="btn secondary" type="button" disabled={!isConnected || working} onClick={acceptInvite}>
                {working ? 'SIGNING / SAVING…' : isConnected ? 'CONFIRM REFERRAL →' : 'CONNECT WALLET FIRST'}
              </button>
            </div>
          ) : null}
          {referrer && !validInvite ? <p className="rewards-note">You cannot refer your own wallet.</p> : null}
          {message ? <p className="referral-feedback" role="status">{message}</p> : null}
        </article>
        <aside className="rewards-panel rewards-explainer">
          <span className="eyebrow">HOW IT WORKS</span>
          <h2>Share. Connect. Confirm.</h2>
          <ol>
            <li><b>01</b><span>Copy your personal referral link.</span></li>
            <li><b>02</b><span>Your invitee connects their wallet and signs a message.</span></li>
            <li><b>03</b><span>The referral is saved for future eligibility review.</span></li>
          </ol>
          <p className="rewards-note">Reward payouts, rankings, points and trading-volume incentives are not active. Terms and eligibility have not been announced.</p>
          <NavLink className="inline-cta" to="/campaigns">VIEW CAMPAIGN PLANS →</NavLink>
        </aside>
      </div>
    </section>
  );
}

const plannedCampaigns = [
  { id: '01', kind: 'TRADING', title: 'Trade on Arc', copy: 'Future campaigns may review eligible market activity. Trading volume alone does not guarantee a reward.' },
  { id: '02', kind: 'CONTENT', title: 'Tell the story', copy: 'Original posts, videos and educational content may be reviewed in future creator campaigns.' },
  { id: '03', kind: 'COMMUNITY', title: 'Build together', copy: 'Useful feedback and meaningful participation may qualify in future community programs.' },
];

export function Campaigns() {
  return (
    <section className="page rewards-page">
      <div className="rewards-intro">
        <span className="eyebrow">COMMUNITY / 02</span>
        <h1>CAMPAIGNS <mark>ARE COMING.</mark></h1>
        <p>We are preparing community programs for traders, creators, and active MemeVerse users. No reward campaign is open yet.</p>
      </div>
      <div className="campaign-status" role="status">
        <span className="status-dot" />
        PROGRAM IN PREPARATION
        <span>Not accepting entries or claims yet.</span>
      </div>
      <div className="campaign-grid">
        {plannedCampaigns.map((campaign) => (
          <article className="campaign-card" key={campaign.id}>
            <div className="campaign-card-top"><span>{campaign.id} / {campaign.kind}</span><small>PLANNED</small></div>
            <h2>{campaign.title}</h2>
            <p>{campaign.copy}</p>
            <div className="campaign-card-bottom">Rules and dates to be announced</div>
          </article>
        ))}
      </div>
      <div className="campaign-disclaimer">
        <strong>Rewards are not live.</strong>
        <p>There are no automatic payments, guaranteed allocations, retroactive credits, or live points. Any future rewards require announced rules and separate verification.</p>
        <NavLink className="btn secondary" to="/referral">EXPLORE REFERRALS →</NavLink>
      </div>
    </section>
  );
}
