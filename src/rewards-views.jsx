import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSignMessage } from 'wagmi';
import { arc } from './arc.js';
import { useArcNetwork } from './use-arc-network.js';
import { createReferralInvite, registerReferral } from './api.js';
import { referralAddress, referralCode, referralMessage, referralShareUrl } from './referral.js';
import { NavLink } from './router.jsx';

export function Referral({ connectWallet }) {
  const { address, isConnected } = useArcNetwork();
  const { signMessageAsync } = useSignMessage();
  const [incoming] = useState(() => new URLSearchParams(window.location.search).get('ref'));
  const legacyWallet = referralAddress(incoming);
  const ownInvite = useQuery({ queryKey: ['referral-invite', arc.id, address], queryFn: () => createReferralInvite(address), enabled: Boolean(address), staleTime: Infinity, retry: 1 });
  const legacyInvite = useQuery({ queryKey: ['referral-invite', arc.id, legacyWallet], queryFn: () => createReferralInvite(legacyWallet), enabled: Boolean(legacyWallet), staleTime: Infinity, retry: 1 });
  const code = referralCode(incoming) ?? referralCode(legacyInvite.data?.code);
  const validInvite = Boolean(code && code !== ownInvite.data?.code);
  const shareUrl = address && ownInvite.data?.code ? referralShareUrl(ownInvite.data.code, window.location.origin, import.meta.env.BASE_URL) : null;
  useEffect(() => {
    if (legacyWallet && code) window.history.replaceState(window.history.state, '', referralShareUrl(code, window.location.origin, import.meta.env.BASE_URL));
  }, [legacyWallet, code]);
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
    if (!address || !validInvite || !code || working) return;
    setWorking(true);
    setMessage('');
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({
        message: referralMessage({ wallet: address, code, chainId: arc.id, issuedAt }),
      });
      const result = await registerReferral({ wallet: address, code, issuedAt, signature });
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
          <p>Connect your wallet to generate a short, private invite code. Your wallet address stays out of the link.</p>
          {!isConnected ? <div className="trade-wallet">{connectWallet}</div> : null}
          <label className="referral-label" htmlFor="referral-link">SHAREABLE LINK</label>
          <div className="referral-copy">
            <input id="referral-link" readOnly value={shareUrl ?? (address ? 'Creating your private link…' : 'Connect your wallet to generate a link')} aria-label="Your referral link" onFocus={(event) => event.target.select()} />
            <button className="btn primary" type="button" disabled={!shareUrl} onClick={copyInvite}>COPY LINK</button>
          </div>
          {ownInvite.isError ? <p className="inline-error" role="alert">Couldn’t create your invite. <button className="btn secondary" type="button" onClick={() => ownInvite.refetch()}>TRY AGAIN</button></p> : null}
          <p className="rewards-note">Your link uses a random code instead of a wallet address. A visit alone does not count as a verified referral.</p>
          {validInvite ? (
            <div className="referral-invite">
              <span className="eyebrow">YOUR INVITATION</span>
              <strong>{code}</strong>
              <p>Register this referral with your connected wallet. Signing grants no spending permission and transfers no funds.</p>
              <button className="btn secondary" type="button" disabled={!isConnected || working} onClick={acceptInvite}>
                {working ? 'SIGNING / SAVING…' : isConnected ? 'CONFIRM REFERRAL →' : 'CONNECT WALLET FIRST'}
              </button>
            </div>
          ) : null}
          {code && !validInvite ? <p className="rewards-note">You cannot refer your own wallet.</p> : null}
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
