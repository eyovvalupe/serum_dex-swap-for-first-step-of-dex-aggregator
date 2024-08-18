import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
// import * as anchor from "@project-serum/anchor";
// import { Program } from "@project-serum/anchor";
import { Dexaggregator } from "../target/types/dexaggregator";
import { Coin, Dex, DexMarket, FileKeypair } from "@project-serum/serum-dev-tools";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as utils from "./utils";

const DEX_ADDRESS = 'B5ytTSxaVr9g4VSrnm6mWjMM4PHucFVvq1CforZiGCm7';

const BTC_PRICE = 19000;
const ETH_PRICE = 1300;
const TAKER_FEE = 0.0004;
const { setupOrderbook, Side } = utils;

describe("dexaggregator", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Dexaggregator as Program<Dexaggregator>;
  const connection = program.provider.connection;

  const dexAddres = new PublicKey(DEX_ADDRESS);

  let BTC: Coin, ETH: Coin, USDC: Coin,
    btcMarket: DexMarket,
    ethMarket: DexMarket,
    btcMarketVaultSigner: PublicKey,
    ethMarketVaultSigner: PublicKey;

  const MarketsOwner = FileKeypair.loadOrGenerate("./owner.json");
  const marketsOwner = MarketsOwner.keypair;

  const Alice = Keypair.generate();

  let
    aliceBtcAccount: PublicKey,
    aliceEthAccount: PublicKey,
    aliceUsdcAccount: PublicKey;

  const dex = new Dex(dexAddres, connection);

  it("BOILERPLATE: Sets up the dex, coins and the markets", async () => {
    await connection.confirmTransaction(
      await connection.requestAirdrop(
        marketsOwner.publicKey,
        100 * LAMPORTS_PER_SOL
      ),
      'confirmed'
    );

    BTC = await dex.createCoin('BTC', 6, marketsOwner, marketsOwner, marketsOwner);
    ETH = await dex.createCoin('ETH', 6, marketsOwner, marketsOwner, marketsOwner);
    USDC = await dex.createCoin('USDC', 6, marketsOwner, marketsOwner, marketsOwner);

    btcMarket = await dex.initDexMarket(marketsOwner, BTC, USDC, {
      tickSize: 0.1,
      lotSize: 0.0001,
    });

    btcMarketVaultSigner = PublicKey.createProgramAddressSync(
      [
        btcMarket.address.toBuffer(),
        btcMarket.serumMarket.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      dexAddres
    );

    ethMarket = await dex.initDexMarket(marketsOwner, ETH, USDC, {
      lotSize: 0.001,
      tickSize: 0.001,
    });

    ethMarketVaultSigner = PublicKey.createProgramAddressSync(
      [
        ethMarket.address.toBuffer(),
        ethMarket.serumMarket.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      dexAddres
    );

    await BTC.fundAccount(1e10, marketsOwner, connection);
    await ETH.fundAccount(1e10, marketsOwner, connection);
    await USDC.fundAccount(1e10, marketsOwner, connection);

    await setupOrderbook(connection, {
      market: btcMarket,
      marketMaker: marketsOwner,
      midPrice: BTC_PRICE,
      size: 100,
    });

    await setupOrderbook(connection, {
      market: ethMarket,
      marketMaker: marketsOwner,
      midPrice: ETH_PRICE,
      size: 1000,
    });

  });

  it("BOILERPLATE: Sets up account for Alice", async () => {
    await connection.confirmTransaction(
      await connection.requestAirdrop(
        Alice.publicKey,
        10 * LAMPORTS_PER_SOL
      ),
      'confirmed'
    );

    await BTC.fundAccount(10, Alice, connection);
    await ETH.fundAccount(100, Alice, connection);
    await USDC.fundAccount(1e7, Alice, connection);

    aliceBtcAccount = await getAssociatedTokenAddress(BTC.mint, Alice.publicKey);
    aliceEthAccount = await getAssociatedTokenAddress(ETH.mint, Alice.publicKey);
    aliceUsdcAccount = await getAssociatedTokenAddress(USDC.mint, Alice.publicKey);
  });

  it('should swap from BTC -> USDC', async () => {
    const swapBtcInput = 1;
    const expectedUsdcOutput = (BTC_PRICE - 1) * (1 - TAKER_FEE);

    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const swapTx = await program.methods
      .swap(
        Side.Ask,
        new anchor.BN(swapBtcInput * 10 ** BTC.decimals),
        new anchor.BN(0),
      )
      .accounts({
        market: {
          market: btcMarket.address,
          requestQueue: btcMarket.serumMarket.decoded.requestQueue,
          eventQueue: btcMarket.serumMarket.decoded.eventQueue,
          marketBids: btcMarket.serumMarket.decoded.bids,
          marketAsks: btcMarket.serumMarket.decoded.asks,
          coinVault: btcMarket.serumMarket.decoded.baseVault,
          pcVault: btcMarket.serumMarket.decoded.quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: true });

    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-btcBalanceChange === swapBtcInput);
    assert.ok(usdcBalanceChange <= expectedUsdcOutput);
  });

  it('should swap from USDC -> BTC', async () => {
    const swapUsdcInput = 1000;
    const expectedBtcOutput = swapUsdcInput / (BTC_PRICE + 1) * (1 - TAKER_FEE);

    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const swapTx = await program.methods
      .swap(
        Side.Bid,
        new anchor.BN(1e3 * 10 ** USDC.decimals),
        new anchor.BN(0),
      )
      .accounts({
        market: {
          market: btcMarket.address,
          requestQueue: btcMarket.serumMarket.decoded.requestQueue,
          eventQueue: btcMarket.serumMarket.decoded.eventQueue,
          marketBids: btcMarket.serumMarket.decoded.bids,
          marketAsks: btcMarket.serumMarket.decoded.asks,
          coinVault: btcMarket.serumMarket.decoded.baseVault,
          pcVault: btcMarket.serumMarket.decoded.quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: true });
    console.log(swapTx);
    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-usdcBalanceChange <= swapUsdcInput);
    assert.ok(btcBalanceChange <= expectedBtcOutput);
  });

  it('should fail to swap because min output not met', async () => {
    const swapBtcInput = 1;
    const expectedUsdcOutput = (BTC_PRICE - 1) * (1 - TAKER_FEE);
    const expectedToFailMinUsdcOutput = expectedUsdcOutput + 1;

    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    try {
      const swapTx = await program.methods
        .swap(
          Side.Ask,
          new anchor.BN(swapBtcInput * 10 ** BTC.decimals),
          new anchor.BN(expectedToFailMinUsdcOutput * 10 ** USDC.decimals),
        )
        .accounts({
          market: {
            market: btcMarket.address,
            requestQueue: btcMarket.serumMarket.decoded.requestQueue,
            eventQueue: btcMarket.serumMarket.decoded.eventQueue,
            marketBids: btcMarket.serumMarket.decoded.bids,
            marketAsks: btcMarket.serumMarket.decoded.asks,
            coinVault: btcMarket.serumMarket.decoded.baseVault,
            pcVault: btcMarket.serumMarket.decoded.quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceUsdcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: true });
    } catch (err) {
      const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
      const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

      const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
      const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

      assert.ok(btcBalanceChange === 0);
      assert.ok(usdcBalanceChange === 0);

      return;
    };

    assert.fail("Swap should have failed because min output not met");
  });

  it('should fail to swap because of mints cannot match', async () => {
    const swapBtcInput = 1;

    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    try {
      const swapTx = await program.methods
        .swap(
          Side.Ask,
          new anchor.BN(swapBtcInput * 10 ** BTC.decimals),
          new anchor.BN(0),
        )
        .accounts({
          market: {
            market: btcMarket.address,
            requestQueue: btcMarket.serumMarket.decoded.requestQueue,
            eventQueue: btcMarket.serumMarket.decoded.eventQueue,
            marketBids: btcMarket.serumMarket.decoded.bids,
            marketAsks: btcMarket.serumMarket.decoded.asks,
            coinVault: btcMarket.serumMarket.decoded.baseVault,
            pcVault: btcMarket.serumMarket.decoded.quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceBtcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: true });
    } catch (err) {
      const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
      const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

      const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
      const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

      assert.ok(btcBalanceChange === 0);
      assert.ok(usdcBalanceChange === 0);

      return;
    };

    assert.fail('Swap should have failed');
  });

  it('should swap transitively from ETH -> BTC', async () => {
    const swapEthInput = 1;
    const expectedBtcOutput = swapEthInput * (ETH_PRICE - 1) / (BTC_PRICE + 1) * (1 - TAKER_FEE);

    const ethBalanceBefore = await connection.getTokenAccountBalance(aliceEthAccount);
    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const swapTx = await program.methods.swapTransitive(
      new anchor.BN(1 * 10 ** ETH.decimals),
      new anchor.BN(0),
    )
      .accounts({
        from: {
          market: ethMarket.address,
          requestQueue: ethMarket.serumMarket.decoded.requestQueue,
          eventQueue: ethMarket.serumMarket.decoded.eventQueue,
          marketBids: ethMarket.serumMarket.decoded.bids,
          marketAsks: ethMarket.serumMarket.decoded.asks,
          coinVault: ethMarket.serumMarket.decoded.baseVault,
          pcVault: ethMarket.serumMarket.decoded.quoteVault,
          vaultSigner: ethMarketVaultSigner,
          coinWallet: aliceEthAccount,
        },
        to: {
          market: btcMarket.address,
          requestQueue: btcMarket.serumMarket.decoded.requestQueue,
          eventQueue: btcMarket.serumMarket.decoded.eventQueue,
          marketBids: btcMarket.serumMarket.decoded.bids,
          marketAsks: btcMarket.serumMarket.decoded.asks,
          coinVault: btcMarket.serumMarket.decoded.baseVault,
          pcVault: btcMarket.serumMarket.decoded.quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: true });
    console.log('swapTx', swapTx);
    const ethBalanceAfter = await connection.getTokenAccountBalance(aliceEthAccount);
    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const ethBalanceChange = ethBalanceAfter.value.uiAmount - ethBalanceBefore.value.uiAmount;
    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-ethBalanceChange <= swapEthInput);
    assert.ok(btcBalanceChange <= expectedBtcOutput);
    assert.ok(usdcBalanceChange >= 0);
  });

  it('should fail to swap transitively because min output not met', async () => {
    const swapEthInput = 1;
    const expectedBtcOutput = swapEthInput * (ETH_PRICE - 1) / (BTC_PRICE + 1) * (1 - TAKER_FEE);
    const expectedToFailMinBtcOutput = expectedBtcOutput + 1;

    const ethBalanceBefore = await connection.getTokenAccountBalance(aliceEthAccount);
    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    try {
      const swapTx = await program.methods.swapTransitive(
        new anchor.BN(1 * 10 ** ETH.decimals),
        new anchor.BN(expectedToFailMinBtcOutput * 10 ** BTC.decimals),
      )
        .accounts({
          from: {
            market: ethMarket.address,
            requestQueue: ethMarket.serumMarket.decoded.requestQueue,
            eventQueue: ethMarket.serumMarket.decoded.eventQueue,
            marketBids: ethMarket.serumMarket.decoded.bids,
            marketAsks: ethMarket.serumMarket.decoded.asks,
            coinVault: ethMarket.serumMarket.decoded.baseVault,
            pcVault: ethMarket.serumMarket.decoded.quoteVault,
            vaultSigner: ethMarketVaultSigner,
            coinWallet: aliceEthAccount,
          },
          to: {
            market: btcMarket.address,
            requestQueue: btcMarket.serumMarket.decoded.requestQueue,
            eventQueue: btcMarket.serumMarket.decoded.eventQueue,
            marketBids: btcMarket.serumMarket.decoded.bids,
            marketAsks: btcMarket.serumMarket.decoded.asks,
            coinVault: btcMarket.serumMarket.decoded.baseVault,
            pcVault: btcMarket.serumMarket.decoded.quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceUsdcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: true });
    } catch (err) {
      const ethBalanceAfter = await connection.getTokenAccountBalance(aliceEthAccount);
      const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
      const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

      const ethBalanceChange = ethBalanceAfter.value.uiAmount - ethBalanceBefore.value.uiAmount;
      const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
      const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

      assert.ok(ethBalanceChange === 0);
      assert.ok(btcBalanceChange === 0);
      assert.ok(usdcBalanceChange === 0);

      return;
    }

    assert.fail('Swap Transitive should have failed because min output not met');
  });

  it('should fail to swap transitively because mints cannot match', async () => {
    const swapEthInput = 1;
    const expectedBtcOutput = swapEthInput * (ETH_PRICE - 1) / (BTC_PRICE + 1) * (1 - TAKER_FEE);
    const expectedToFailMinBtcOutput = expectedBtcOutput + 1;

    const ethBalanceBefore = await connection.getTokenAccountBalance(aliceEthAccount);
    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    try {
      const swapTx = await program.methods.swapTransitive(
        new anchor.BN(1 * 10 ** ETH.decimals),
        new anchor.BN(0),
      )
        .accounts({
          from: {
            market: ethMarket.address,
            requestQueue: ethMarket.serumMarket.decoded.requestQueue,
            eventQueue: ethMarket.serumMarket.decoded.eventQueue,
            marketBids: ethMarket.serumMarket.decoded.bids,
            marketAsks: ethMarket.serumMarket.decoded.asks,
            coinVault: ethMarket.serumMarket.decoded.baseVault,
            pcVault: ethMarket.serumMarket.decoded.quoteVault,
            vaultSigner: ethMarketVaultSigner,
            coinWallet: aliceEthAccount,
          },
          to: {
            market: btcMarket.address,
            requestQueue: btcMarket.serumMarket.decoded.requestQueue,
            eventQueue: btcMarket.serumMarket.decoded.eventQueue,
            marketBids: btcMarket.serumMarket.decoded.bids,
            marketAsks: btcMarket.serumMarket.decoded.asks,
            coinVault: btcMarket.serumMarket.decoded.baseVault,
            pcVault: btcMarket.serumMarket.decoded.quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceBtcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: true });
    } catch (err) {
      const ethBalanceAfter = await connection.getTokenAccountBalance(aliceEthAccount);
      const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
      const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

      const ethBalanceChange = ethBalanceAfter.value.uiAmount - ethBalanceBefore.value.uiAmount;
      const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
      const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

      assert.ok(ethBalanceChange === 0);
      assert.ok(btcBalanceChange === 0);
      assert.ok(usdcBalanceChange === 0);

      return;
    }

    assert.fail('Swap Transitive should have failed because mints cannot match');
  });
});
