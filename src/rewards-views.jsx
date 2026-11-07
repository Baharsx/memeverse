import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSignMessage } from 'wagmi';
import { arc, arcLinks } from './arc.js';
import { useArcNetwork } from './use-arc-network.js';
import { createReferralInvite, getRewards, getWalletRewards, registerReferral } from './api.js';
import { referralAddress, referralCode, referralMessage, referralShareUrl } from './referral.js';
import { formatReward, timeLeft } from './rewards.js';
import { shortTrader } from './activity.js';
import { NavLink } from './router.jsx';

function rewardsQuery() {
  return { queryKey: ['rewards'], queryFn: getRewards, staleTime: 10_000, refetchInterval: 30_000 };
}

function walletRewardsQuery(address) {
  return { queryKey: ['rewards', address], queryFn: () => getWalletRewards(address), enabled: Boolean(address), staleTime: 10_000, refetchInterval: 30_000 };
}

function Stat({ label, value, accent = false }) {
  return <div className={`reward-stat${accent ? ' accent' : ''}`}><small>{label}</small><strong>{value}</strong></div>;
}

/** The wallet's own numbers, shared by both pages. */
function YourRewards({ data, focus }) {
  if (!data?.thisWeek) return null; // An empty or older API answer shows nothing rather than failing.
  return (
    <div className="reward-stats" aria-label="Your rewards">
      {focus === 'referral' ? (
        <>
          <Stat label="FRIENDS JOINED" value={data.invited} />
          <Stat label="FRIENDS TRADING" value={data.invitedTraded} />
          <Stat label="THIS WEEK" value={formatReward(data.thisWeek.referral)} accent />
        </>
      ) : (
        <>
          <Stat label="YOUR VOLUME THIS WEEK" value={formatReward(data.thisWeek.volume)} />
          <Stat label="YOUR SHARE SO FAR" value={formatReward(data.thisWeek.trading)} accent />
        </>
      )}
      <Stat label="EARNED" value={formatReward(data.earned)} />
      <Stat label="PAID OUT" value={formatReward(data.paid)} />
      <Stat label="NEXT PAYOUT" value={formatReward(data.unpaid)} />
    </div>
  );
}

const shareText = 'Launch a meme for $0 on @memeversebiz and trade it from $1 on @Arc 🟩';

export function Referral({ connectWallet }) {
  const { address, isConnected } = useArcNetwork();
  const { signMessageAsync } = useSignMessage();
  const [incoming] = useState(() => new URLSearchParams(window.location.search).get('ref'));
  const legacyWallet = referralAddress(incoming);
  const ownInvite = useQuery({ queryKey: ['referral-invite', arc.id, address], queryFn: () => createReferralInvite(address), enabled: Boolean(address), staleTime: Infinity, retry: 1 });
  const legacyInvite = useQuery({ queryKey: ['referral-invite', arc.id, legacyWallet], queryFn: () => createReferralInvite(legacyWallet), enabled: Boolean(legacyWallet), staleTime: Infinity, retry: 1 });
  const mine = useQuery(walletRewardsQuery(address));
  const code = referralCode(incoming) ?? referralCode(legacyInvite.data?.code);
  const validInvite = Boolean(code && code !== ownInvite.data?.code);
  const shareUrl = address && ownInvite.data?.code ? referralShareUrl(ownInvite.data.code, window.location.origin, import.meta.env.BASE_URL) : null;
  useEffect(() => {
    if (legacyWallet && code) window.history.replaceState(window.history.state, '', referralShareUrl(code, window.location.origin, import.meta.env.BASE_URL));
  }, [legacyWallet, code]);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyInvite() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    } catch {
      setMessage('Copy the link from the field instead.');
    }
  }

  async function acceptInvite() {
    if (!address || !validInvite || !code || working) return;
    setWorking(true);
    setMessage('');
    try {
      const issuedAt = new Date().toISOString();
      const signature = await signMessageAsync({ message: referralMessage({ wallet: address, code, chainId: arc.id, issuedAt }) });
      const result = await registerReferral({ wallet: address, code, issuedAt, signature });
      setMessage(result.existing ? 'You are already linked to this friend.' : 'You are in. Your friend now earns from your trades, at no cost to you.');
    } catch (error) {
      setMessage(error?.code === 4001 || error?.name === 'UserRejectedRequestError'
        ? 'Signature cancelled. Nothing was recorded.'
        : (error?.message ?? 'Could not save this invite. Please try again.'));
    } finally {
      setWorking(false);
    }
  }

  const xIntent = shareUrl ? `https://x.com/intent/post?text=${encodeURIComponent(`${shareText}\n\n${shareUrl}`)}` : null;

  return (
    <section className="page rewards-page">
      <div className="rewards-intro">
        <span className="eyebrow">REFERRAL</span>
        <h1>INVITE FRIENDS. <mark>EARN 20%.</mark></h1>
        <p>Get 20% of MemeVerse’s fee on every trade your friends make, for as long as they trade. Paid in USDC every week.</p>
      </div>
      {validInvite ? (
        <div className="referral-invite" role="region" aria-label="Your invitation">
          <div>
            <strong>A friend invited you.</strong>
            <p>Accept with a free signature. It costs nothing, moves no funds and never changes your fees.</p>
          </div>
          {isConnected
            ? <button className="btn primary" type="button" disabled={working} onClick={acceptInvite}>{working ? 'SIGNING…' : 'ACCEPT INVITE →'}</button>
            : <div className="trade-wallet">{connectWallet}</div>}
        </div>
      ) : null}
      {code && !validInvite && ownInvite.data ? <p className="rewards-note">This is your own link. Share it with a friend.</p> : null}
      {message ? <p className="referral-feedback" role="status">{message}</p> : null}

      <article className="rewards-panel referral-share">
        <span className="eyebrow">YOUR LINK</span>
        {!isConnected ? (
          <><p>Connect your wallet to get your personal link.</p><div className="trade-wallet">{connectWallet}</div></>
        ) : (
          <>
            <div className="referral-copy">
              <input id="referral-link" readOnly value={shareUrl ?? 'Creating your link…'} aria-label="Your referral link" onFocus={(event) => event.target.select()} />
              <button className="btn primary" type="button" disabled={!shareUrl} onClick={copyInvite}>{copied ? 'COPIED ✓' : 'COPY'}</button>
              <a className={`btn secondary${xIntent ? '' : ' disabled'}`} href={xIntent ?? undefined} target="_blank" rel="noreferrer noopener" aria-disabled={!xIntent}>SHARE ON X ↗</a>
            </div>
            {ownInvite.isError ? <p className="rewards-note">Couldn’t create your link. <button className="trade-cancel" type="button" onClick={() => ownInvite.refetch()}>Try again</button></p> : null}
            <YourRewards data={mine.data} focus="referral" />
          </>
        )}
      </article>

      <ol className="reward-steps">
        <li><b>01</b><span><strong>Share your link</strong>It holds a random code, never your wallet address.</span></li>
        <li><b>02</b><span><strong>Friends accept</strong>They connect and sign once. Free, and their fees stay the same.</span></li>
        <li><b>03</b><span><strong>Earn every week</strong>20% of the platform fee on their trades, paid in USDC every Monday.</span></li>
      </ol>
      <p className="rewards-fineprint">Rewards come only from MemeVerse’s own trading fee. Payouts of at least $0.05 are sent from the treasury after each week ends; smaller amounts carry over. Referring your own wallets earns less than the fees it costs. <NavLink to="/campaigns">Weekly trading pool →</NavLink></p>
    </section>
  );
}

export function Campaigns({ connectWallet }) {
  const { address, isConnected } = useArcNetwork();
  const rewards = useQuery(rewardsQuery());
  const mine = useQuery(walletRewardsQuery(address));
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((value) => value + 1), 30_000); return () => clearInterval(timer); }, []);
  const data = rewards.data;
  const week = data?.current?.end ? data.current : null;

  return (
    <section className="page rewards-page">
      <div className="rewards-intro">
        <span className="eyebrow">CAMPAIGN{week ? ` / WEEK ${week.epoch}` : ''}</span>
        <h1>TRADE. <mark>EARN EVERY WEEK.</mark></h1>
        <p>30% of MemeVerse’s trading fee goes into a weekly pool, shared by everyone who trades. The more you trade, the bigger your share.</p>
      </div>

      <article className="rewards-panel pool-card" aria-label="This week's pool">
        <div className="pool-main">
          <small>THIS WEEK’S POOL</small>
          <strong>{week ? formatReward(week.tradingPool) : '—'}</strong>
          <span>{week ? `Grows with every trade · ends in ${timeLeft(week.end)}` : rewards.isPending ? 'Loading…' : 'Unavailable right now'}</span>
        </div>
        {week ? (
          <div className="pool-facts">
            <Stat label="TRADERS" value={week.traders} />
            <Stat label="TRADES" value={week.trades} />
            <Stat label="VOLUME" value={formatReward(week.volume)} />
          </div>
        ) : null}
      </article>

      {isConnected ? <article className="rewards-panel"><span className="eyebrow">YOU</span><YourRewards data={mine.data} focus="trading" /></article>
        : <article className="rewards-panel connect-panel"><p>Connect your wallet to see your share.</p><div className="trade-wallet">{connectWallet}</div></article>}

      <article className="rewards-panel">
        <span className="eyebrow">LEADERBOARD · THIS WEEK</span>
        {data?.leaderboard?.length ? (
          <ol className="reward-board">
            {data.leaderboard.map((row) => (
              <li key={row.wallet} className={address && row.wallet.toLowerCase() === address.toLowerCase() ? 'is-you' : undefined}>
                <b>{row.rank}</b>
                <span>{shortTrader(row.wallet)}{address && row.wallet.toLowerCase() === address.toLowerCase() ? ' · you' : ''}</span>
                <span>{formatReward(row.volume)}</span>
                <strong>{formatReward(row.reward)}</strong>
              </li>
            ))}
          </ol>
        ) : <p className="rewards-note">No trades this week yet. The first trade starts the pool. <NavLink to="/markets">Explore markets →</NavLink></p>}
      </article>

      <ol className="reward-steps">
        <li><b>01</b><span><strong>Trade any meme</strong>Every trade pays a 1% fee to MemeVerse.</span></li>
        <li><b>02</b><span><strong>30% goes to the pool</strong>Shared by everyone who traded this week, by volume.</span></li>
        <li><b>03</b><span><strong>Paid every Monday</strong>USDC straight to your wallet after the week ends.</span></li>
      </ol>

      {data?.history?.length || data?.paid?.recent?.length ? (
        <article className="rewards-panel">
          <span className="eyebrow">PAST WEEKS</span>
          <ul className="reward-history">
            {data.history.map((item) => (
              <li key={item.epoch}><span>Week {item.epoch}</span><span>{item.traders} trader{item.traders === 1 ? '' : 's'}</span><strong>{formatReward(item.tradingPool)}</strong></li>
            ))}
            {data.paid.recent.map((item) => (
              <li key={item.tx}><span>Paid {shortTrader(item.wallet)}</span><a href={`${arcLinks.explorer}/tx/${item.tx}`} target="_blank" rel="noreferrer noopener">View ↗</a><strong>{formatReward(item.amount)}</strong></li>
            ))}
          </ul>
        </article>
      ) : null}

      <p className="rewards-fineprint">The pool is funded only by MemeVerse’s own trading revenue, so it is real USDC, not points. Your share equals 30% of the platform fee your trades paid, so trading against yourself always costs more than it earns. Payouts of at least $0.05 are sent after each week ends; smaller amounts carry over. <NavLink to="/referral">Invite friends for another 20% →</NavLink></p>
    </section>
  );
}
