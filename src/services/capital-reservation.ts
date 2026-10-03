import { CapitalReservation, PendingOrderRecord } from '../types/index.js';

export class CapitalReservationLedger {
  private static instance: CapitalReservationLedger;
  private reservations: Map<string, CapitalReservation> = new Map();

  public static getInstance(): CapitalReservationLedger {
    if (!CapitalReservationLedger.instance) {
      CapitalReservationLedger.instance = new CapitalReservationLedger();
    }
    return CapitalReservationLedger.instance;
  }

  /**
   * Calculates current spendable lamports available for new trades:
   * spendable = cachedBalance - activeReservations - reserveFloor
   */
  public calculateSpendableLamports(
    cachedBalanceLamports: bigint,
    reserveFloorLamports: bigint
  ): bigint {
    const totalReserved = this.getTotalReservedLamports();
    const locked = totalReserved + reserveFloorLamports;
    if (cachedBalanceLamports <= locked) {
      return 0n;
    }
    return cachedBalanceLamports - locked;
  }

  public getSpendableBalance(
    cachedBalanceLamports: bigint,
    reserveFloorLamports: bigint = 0n
  ): bigint {
    return this.calculateSpendableLamports(cachedBalanceLamports, reserveFloorLamports);
  }

  public reserveSimple(
    idempotencyKey: string,
    tokenMint: string,
    totalLamportsRequired: bigint,
    targetWallet: string = 'unknown'
  ): void {
    this.reservations.set(idempotencyKey, {
      idempotencyKey,
      targetWallet,
      tokenMint,
      totalLamports: totalLamportsRequired,
      createdAt: Date.now(),
    });
  }

  /**
   * Checks whether the required outlay can be reserved safely
   */
  public canSpend(
    requiredLamports: bigint,
    cachedBalanceLamports: bigint,
    reserveFloorLamports: bigint
  ): boolean {
    const spendable = this.calculateSpendableLamports(
      cachedBalanceLamports,
      reserveFloorLamports
    );
    return spendable >= requiredLamports;
  }

  /**
   * Atomically places a capital reservation for an in-flight order.
   * Total required includes: trade outlay + base fee + priority fee + tip.
   */
  public reserve(
    idempotencyKey: string,
    targetWallet: string,
    tokenMint: string,
    totalLamportsRequired: bigint,
    cachedBalanceLamports: bigint,
    reserveFloorLamports: bigint
  ): { success: boolean; spendableLamports: bigint; reason?: string } {
    if (this.reservations.has(idempotencyKey)) {
      return {
        success: false,
        spendableLamports: this.calculateSpendableLamports(cachedBalanceLamports, reserveFloorLamports),
        reason: 'Order with this idempotency key already has active reservation',
      };
    }

    const spendable = this.calculateSpendableLamports(
      cachedBalanceLamports,
      reserveFloorLamports
    );

    if (spendable < totalLamportsRequired) {
      return {
        success: false,
        spendableLamports: spendable,
        reason: `Insufficient spendable balance: needed ${totalLamportsRequired.toString()} lamports, but only ${spendable.toString()} lamports available after ${this.getTotalReservedLamports().toString()} active reservations`,
      };
    }

    this.reservations.set(idempotencyKey, {
      idempotencyKey,
      targetWallet,
      tokenMint,
      totalLamports: totalLamportsRequired,
      createdAt: Date.now(),
    });

    const newSpendable = this.calculateSpendableLamports(
      cachedBalanceLamports,
      reserveFloorLamports
    );

    return {
      success: true,
      spendableLamports: newSpendable,
    };
  }

  /**
   * Releases reservation upon definitive lifecycle resolution (FILLED, FAILED, EXPIRED)
   */
  public release(idempotencyKey: string): boolean {
    return this.reservations.delete(idempotencyKey);
  }

  /**
   * Returns sum of all active reserved lamports
   */
  public getTotalReservedLamports(): bigint {
    let sum = 0n;
    for (const res of this.reservations.values()) {
      sum += res.totalLamports;
    }
    return sum;
  }

  /**
   * Returns all active reservations
   */
  public getActiveReservations(): CapitalReservation[] {
    return Array.from(this.reservations.values());
  }

  /**
   * Populates reservations on startup from unresolved database records
   */
  public repopulateFromPendingOrders(unresolvedOrders: PendingOrderRecord[]): void {
    this.reservations.clear();
    for (const order of unresolvedOrders) {
      try {
        const reserved = BigInt(order.reservedLamports || order.amountInLamports || '0');
        if (reserved > 0n) {
          this.reservations.set(order.idempotencyKey, {
            idempotencyKey: order.idempotencyKey,
            targetWallet: 'unknown',
            tokenMint: order.tokenMint,
            totalLamports: reserved,
            createdAt: order.createdAt,
          });
        }
      } catch {}
    }
  }

  /**
   * For testing only
   */
  public clear(): void {
    this.reservations.clear();
  }
}

export const capitalReservationLedger = CapitalReservationLedger.getInstance();
