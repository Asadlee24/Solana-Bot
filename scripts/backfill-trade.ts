import { Connection } from '@solana/web3.js';
import { ParsedTransactionEnvelope } from '../src/parsers/fast-decoder.js';
import { signalManager } from '../src/streams/signal-manager.js';

const TARGET_SIG = '64TisUsRwcGdFJgtNoZaEiY8gSD1Bpz9mcSkCMpiBhFUx2tAr2s97zoHWomT6BA8ehvg8FEA1JTMmN8USSyugzku';

async function backfill() {
  console.log('Fetching on-chain transaction:', TARGET_SIG);
  const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=50b050ea-c7da-4541-bc3f-6e1b11240977');
  const txRes = await conn.getParsedTransaction(TARGET_SIG, { maxSupportedTransactionVersion: 0 });

  if (!txRes || !txRes.transaction) {
    console.error('Failed to fetch transaction');
    process.exit(1);
  }

  const message = txRes.transaction.message;
  const accountKeys = message.accountKeys.map((k: any) =>
    typeof k === 'string' ? k : k.pubkey.toBase58()
  );
  const signers = message.accountKeys
    .filter((k: any) => (typeof k === 'object' ? k.signer : false))
    .map((k: any) => (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58()));

  const instructions = (message.instructions || []).map((ix: any) => {
    const programId = ix.programId ? ix.programId.toBase58() : ix.program || '';
    const accounts = (ix.accounts || []).map((a: any) =>
      typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a)
    );
    const data = Buffer.from(ix.data || '', 'base64');
    return { programId, accounts, data };
  });

  const envelope: ParsedTransactionEnvelope = {
    signature: TARGET_SIG,
    slot: txRes.slot,
    signers: signers.length > 0 ? signers : [accountKeys[0]],
    accountKeys,
    instructions,
    meta: {
      err: txRes.meta?.err || null,
      fee: txRes.meta?.fee || 5000,
      preBalances: txRes.meta?.preBalances || [],
      postBalances: txRes.meta?.postBalances || [],
      preTokenBalances: txRes.meta?.preTokenBalances as any,
      postTokenBalances: txRes.meta?.postTokenBalances as any,
    },
    observedAt: process.hrtime.bigint(),
  };

  console.log('Ingesting transaction into signalManager...');
  const result = await signalManager.handleIncomingTransaction(envelope, 'RPC_FALLBACK', 'CONFIRMED');
  console.log('Result:', result.order ? `SUCCESS! Order ID: ${result.order.orderId}` : 'NO_ORDER');
  process.exit(0);
}

backfill().catch(console.error);
