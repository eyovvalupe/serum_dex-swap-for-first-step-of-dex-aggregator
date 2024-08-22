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
import { Market } from "@project-serum/serum";

const DEX_ADDRESS = 'DESVgJVGajEgKGXhb6XmqDHGz3VjdgP7rEVESBgxmroY';

const BTC_PRICE = 60000;
const ETH_PRICE = 1300;
const TAKER_FEE = 0.0004;
const USER_FEE = 0.01;
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

  const MarketsOwnerSecretKey = "118,4,127,28,75,124,21,179,4,250,213,173,60,105,133,10,134,127,146,160,126,57,171,151,175,64,198,113,139,61,76,79,192,111,175,89,144,126,239,243,228,99,15,88,38,89,227,254,144,31,90,35,23,107,9,110,119,174,14,83,216,53,215,105"
  let keyOwner = Uint8Array.from(MarketsOwnerSecretKey.split(',').map(i => parseInt(i)));
  const marketsOwner = Keypair.fromSecretKey(keyOwner);
  // const balanceLamports = await connection.getBalance(new PublicKey(marketsOwner));
  // const balanceInSOL = balanceLamports / LAMPORTS_PER_SOL;
  // console.log(`MarketOwner has ${balanceInSOL} SOL`);

  const secretKey = "50,165,8,189,221,75,244,135,134,126,59,153,51,130,29,44,209,91,5,97,193,118,26,147,99,208,233,114,195,113,36,46,213,242,246,132,115,89,200,50,200,32,190,81,242,23,150,118,242,245,63,113,166,121,64,101,178,234,41,76,51,239,177,232"
  let key = Uint8Array.from(secretKey.split(',').map(i => parseInt(i)));
  const Alice = Keypair.fromSecretKey(key);


  let
    aliceBtcAccount: PublicKey,
    aliceEthAccount: PublicKey,
    aliceUsdcAccount: PublicKey;

  const dex = new Dex(dexAddres, connection);

  it("Initialize owner", async () => {
    const tx = program.methods
        .initialize(
          marketsOwner.publicKey
        )
        .accounts({})
        .signers([marketsOwner])
        .rpc()
  })

  it("Sets up the dex, coins and the markets", async () => {
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
  
    console.log("BTC mint is ", BTC.mint);
    console.log("btcMarketAddress is ", btcMarket.address);
    console.log("btcMarketVaultSigner is ", btcMarketVaultSigner);

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

    console.log("ETH mint is ", ETH.mint);
    console.log("ethMarketAddress is ", ethMarket.address)
    console.log("ethMarketVaultSigner is ", ethMarketVaultSigner)

    console.log("USDC mint is ", USDC.mint);

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

    let 
      btcAddress: PublicKey,
      ethAddress: PublicKey,
      requestQueue: PublicKey,
      eventQueue: PublicKey,
      bids: PublicKey,
      asks: PublicKey,
      baseVault: PublicKey,
      quoteVault: PublicKey,
      BTCMint: PublicKey,
      ETHMint: PublicKey,
      USDCMint: PublicKey;

    it("Get Market from marketAddress", async () => {
      btcAddress = new PublicKey("4LNpf1yNiMFoZaCAxS9o7gGr8rh6U1d8ewFDdf3TPCMX");
      btcMarketVaultSigner = new PublicKey("43JEEYRRUVwHEh2WeiSoEiz2nhsXKUyQjR4oDQQUQQYM");

      ethAddress = new PublicKey("D1FdYJFs29DKjTTMEoXQNAw6C47RqBV2yPtyT4Mu5XsR");
      ethMarketVaultSigner = new PublicKey("6r11wJxd5EsC5XjT4RESvZCxEuNtXKtTJY45cUWbHBhE");

      BTCMint = new PublicKey("ADYMjcrEmokfZyC7vPrRdwE1VVw85Hbhqy8DnnxH8bmP");
      ETHMint = new PublicKey("88ySs9GibAd7bzck8wG9T7t1vG3HitkifBj91MXKRUgt");
      USDCMint = new PublicKey("8yvpPAk8avJitZbczXMya9tjZZa4s4txK7FCHEFNaoP");
      const market = await Market.load(connection, btcAddress, undefined, dexAddres);

      requestQueue = new PublicKey(market.decoded.requestQueue);
      eventQueue = new PublicKey(market.decoded.eventQueue);
      bids = new PublicKey(market.decoded.bids);
      asks = new PublicKey(market.decoded.asks);
      baseVault = new PublicKey(market.decoded.baseVault);
      quoteVault = new PublicKey(market.decoded.quoteVault);

    })

  it("Sets up account for Alice", async () => {
    await BTC.fundAccount(10, Alice, connection);
    await ETH.fundAccount(100, Alice, connection);
    await USDC.fundAccount(1e7, Alice, connection);

    // aliceBtcAccount = await getAssociatedTokenAddress(BTC.mint, Alice.publicKey);
    // aliceEthAccount = await getAssociatedTokenAddress(ETH.mint, Alice.publicKey);
    // aliceUsdcAccount = await getAssociatedTokenAddress(USDC.mint, Alice.publicKey);

    aliceBtcAccount = await getAssociatedTokenAddress(BTCMint, Alice.publicKey);
    aliceEthAccount = await getAssociatedTokenAddress(ETHMint, Alice.publicKey);
    aliceUsdcAccount = await getAssociatedTokenAddress(USDCMint, Alice.publicKey);
  });

  it('should swap from BTC -> USDC', async () => {
    const swapBtcInput = 1;
    const expectedUsdcOutput = (BTC_PRICE - 1) * (1 - TAKER_FEE);

    const btcBalanceBefore = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceBefore = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const swapTx = await program.methods
      .swap(
        Side.Ask,
        // new anchor.BN(swapBtcInput * 10 ** BTC.decimals),
        new anchor.BN(swapBtcInput * 10 ** 8),
        new anchor.BN(0),
      )
      .accounts({
        market: {
          // market: btcMarket.address,
          market: btcAddress,
          requestQueue: requestQueue,
          eventQueue: eventQueue,
          marketBids: bids,
          marketAsks: asks,
          coinVault: baseVault,
          pcVault: quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: false });

    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-btcBalanceChange === swapBtcInput);
    assert.ok(usdcBalanceChange / (1 - USER_FEE) <= expectedUsdcOutput);
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
          market: btcAddress,
          requestQueue: requestQueue,
          eventQueue: eventQueue,
          marketBids: bids,
          marketAsks: asks,
          coinVault: baseVault,
          pcVault: quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: false });
    console.log(swapTx);
    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-usdcBalanceChange <= swapUsdcInput);
    assert.ok(btcBalanceChange / (1 - USER_FEE) <= expectedBtcOutput);
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
            market: btcAddress,
          requestQueue: requestQueue,
          eventQueue: eventQueue,
          marketBids: bids,
          marketAsks: asks,
          coinVault: baseVault,
          pcVault: quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceUsdcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: false });
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
            market: btcAddress,
            requestQueue: requestQueue,
            eventQueue: eventQueue,
            marketBids: bids,
            marketAsks: asks,
            coinVault: baseVault,
            pcVault: quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceBtcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: false });
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
          market: ethAddress,
          requestQueue: requestQueue,
          eventQueue: eventQueue,
          marketBids: bids,
          marketAsks: asks,
          coinVault: baseVault,
          pcVault: quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        to: {
          market: btcAddress,
          requestQueue: requestQueue,
          eventQueue: eventQueue,
          marketBids: bids,
          marketAsks: asks,
          coinVault: baseVault,
          pcVault: quoteVault,
          vaultSigner: btcMarketVaultSigner,
          coinWallet: aliceBtcAccount,
        },
        walletOwner: Alice.publicKey,
        pcWallet: aliceUsdcAccount,
        dexProgram: dexAddres,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([Alice])
      .rpc({ skipPreflight: false });
    console.log('swapTx', swapTx);
    const ethBalanceAfter = await connection.getTokenAccountBalance(aliceEthAccount);
    const btcBalanceAfter = await connection.getTokenAccountBalance(aliceBtcAccount);
    const usdcBalanceAfter = await connection.getTokenAccountBalance(aliceUsdcAccount);

    const ethBalanceChange = ethBalanceAfter.value.uiAmount - ethBalanceBefore.value.uiAmount;
    const btcBalanceChange = btcBalanceAfter.value.uiAmount - btcBalanceBefore.value.uiAmount;
    const usdcBalanceChange = usdcBalanceAfter.value.uiAmount - usdcBalanceBefore.value.uiAmount;

    assert.ok(-ethBalanceChange <= swapEthInput);
    assert.ok(btcBalanceChange / (1 - USER_FEE) <= expectedBtcOutput);
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
            market: ethAddress,
            requestQueue: requestQueue,
            eventQueue: eventQueue,
            marketBids: bids,
            marketAsks: asks,
            coinVault: baseVault,
            pcVault: quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          to: {
            market: btcAddress,
            requestQueue: requestQueue,
            eventQueue: eventQueue,
            marketBids: bids,
            marketAsks: asks,
            coinVault: baseVault,
            pcVault: quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceUsdcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: false });
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
            market: ethAddress,
            requestQueue: requestQueue,
            eventQueue: eventQueue,
            marketBids: bids,
            marketAsks: asks,
            coinVault: baseVault,
            pcVault: quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          to: {
            market: btcAddress,
            requestQueue: requestQueue,
            eventQueue: eventQueue,
            marketBids: bids,
            marketAsks: asks,
            coinVault: baseVault,
            pcVault: quoteVault,
            vaultSigner: btcMarketVaultSigner,
            coinWallet: aliceBtcAccount,
          },
          walletOwner: Alice.publicKey,
          pcWallet: aliceBtcAccount,
          dexProgram: dexAddres,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([Alice])
        .rpc({ skipPreflight: false });
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

  it('Should fail to withdraw becuase not owner', async () => {
    const withdrawTx = await program.methods
        .withdraw()
        .accounts({})
        .signers([Alice])
        .rpc({ skipPreflight: false });

    const withdrawAmountAfter = await connection.getTokenAccountBalance(marketsOwner.publicKey);
    assert.ok(withdrawAmountAfter.value.uiAmount === 0);
    assert.fail("Person who withdraw is not owner");
  });

  it("Should withdraw if owner is true", async () => {
    const withdrawTx = await program.methods
        .withdraw()
        .accounts({})
        .signers([marketsOwner])
        .rpc({ skipPreflight: false })

    const withdrawAmountAfter = await connection.getTokenAccountBalance(marketsOwner.publicKey);
    assert.ok(withdrawAmountAfter.value.uiAmount > 0);
  })
});
