import Decimal from "decimal.js";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import low from "lowdb";
import FileSync from "lowdb/adapters/FileSync";
import { CompAddress } from "./compAddress";
import { AbiItem } from "web3-utils";
import { Transaction } from "ethereumjs-tx";
import Web3 from "web3";

// import interfaces: Should be the same for mainnet/testnet
import { CETH_JSON_INTERFACE } from "./cEth-interface";
import { CTOKEN_JSON_INTERFACE } from "./cToken-interface";
import { COMPTROLLER_INTERFACE } from "./comptroller-interface";
import { ERC20_INERFACE } from "./erc20-interface";
import { PRICE_ORACLE_INTERFACE } from "./priceOracle-interface";

const CHAIN = "ropsten";

// TODO: Config based on network type
const web3 = new Web3(
  new Web3.providers.HttpProvider(
    `https://${CHAIN}.infura.io/v3/3d93a3a00252437cb50e9a81ad147c99`
  )
);

// TODO add logic to configure by network
import { config, markets_list } from "./ropstenConfig";

const CLIENT_DB_PATH = path.join(__dirname, "../../client_db");

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class Client {
  private mainnet: boolean;
  private db: any;
  private address: CompAddress;

  constructor(mainnet: boolean = false, useAsyncBroadcast: boolean = false) {
    this.mainnet = mainnet;
  }

  public async init() {
    this.initDb();
    this.address = await this.restoreOrGenerate();
  }

  public getAddress(): CompAddress {
    return this.address;
  }

  //// Enter Markets /////
  public async enterMarket(sym: string) {
    const myContract = new web3.eth.Contract(
      COMPTROLLER_INTERFACE,
      config.comptrollerContract
    );
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    const contracts: string[] = [contractAddress];
    const data = myContract.methods.enterMarkets(contracts).encodeABI();
    this.executeTX(config.comptrollerContract, data, "0x0");
  }

  public async enterAllMarkets(sym: string) {
    const myContract = new web3.eth.Contract(
      COMPTROLLER_INTERFACE,
      config.comptrollerContract
    );
    const data = myContract.methods.enterMarkets(markets_list).encodeABI();
    this.executeTX(config.comptrollerContract, data, "0x0");
  }

  /////// Getting balance ////////
  public async getBalanceETH(): Promise<string> {
    const balance = await web3.eth.getBalance(this.address.getAddress());
    const balanceInEth = web3.utils.fromWei(balance, "ether");
    return balanceInEth;
  }

  private async getUnderlyingDecimals(
    contractAddress: string
  ): Promise<number> {
    if (contractAddress === config.cETHContract) {
      return 18;
    }
    const iface = CTOKEN_JSON_INTERFACE;
    const underlyingAddress = await this.getUnderlyingAddress(
      iface,
      contractAddress
    );
    const myContract = new web3.eth.Contract(ERC20_INERFACE, underlyingAddress);
    const decimals = await myContract.methods.decimals().call();
    return decimals;
  }

  private async getBalanceToken(sym: string): Promise<string> {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    const underlyingAddress = await this.getUnderlyingAddress(
      iface,
      contractAddress
    );
    const myContract = new web3.eth.Contract(ERC20_INERFACE, underlyingAddress);

    const balance = await myContract.methods
      .balanceOf(this.address.getAddress())
      .call();

    const decimals = await myContract.methods.decimals().call();

    const base: Decimal = new Decimal(10);
    const coefficient: Decimal = base.pow(-decimals);
    const actualBalance: Decimal = coefficient.mul(balance);
    return actualBalance.toString();
  }

  private async getBalanceCToken(sym: string): Promise<string> {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    const myContract = new web3.eth.Contract(iface, contractAddress);
    let [
      error,
      lendBallance,
      borrowBalance,
      exchangeRate
    ] = await myContract.methods
      .getAccountSnapshot(this.address.getAddress())
      .call();
    let underlyingDecimals = await this.getUnderlyingDecimals(contractAddress);
    let cTokenDecimals: number = await myContract.methods.decimals().call();
    console.log("Token Decimals", cTokenDecimals);
    console.log("Underlying Decimals", underlyingDecimals);
    const base: Decimal = new Decimal(10);

    // Balance in underlying token
    // Get the balance of the underlying token, with the appropriate mantissa
    let coefficient: Decimal = base.pow(-cTokenDecimals);
    const lendBallanceDec: Decimal = coefficient.mul(lendBallance);

    // Exchange rate mantissa
    // The mantissa of the exchange rate is calculated as:
    // 18 + decimals_of_underlying - decimals_of_ctoken
    let decimals = 18;
    const decimlasDiff: number = Number(
      -decimals - Number(underlyingDecimals) + Number(cTokenDecimals)
    );
    coefficient = base.pow(decimlasDiff);
    const exchangeRateDec: Decimal = coefficient.mul(exchangeRate);

    const balanceOfUnderlying = lendBallanceDec.mul(exchangeRateDec);
    return balanceOfUnderlying.toString();
  }

  // Minting Ceth is different as there is not erc20 token
  public async mintCETH(amount: string) {
    const myContract = new web3.eth.Contract(
      CETH_JSON_INTERFACE,
      config.cETHContract
    );
    const data = myContract.methods.mint().encodeABI();
    const nonce = await web3.eth.getTransactionCount(this.address.getAddress());
    const toMint = web3.utils.toWei(amount, "ether");
    const toMintHex = web3.utils.toHex(toMint);
    this.executeTX(config.cETHContract, data, toMintHex);
  }

  private async mintCToken(
    sym: string,
    amount: string,
    nonce?: number,
    gasLimit?: number
  ) {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    // TODO: Check the the amount exists in the account
    const toMintHex = await this.convertToUnderlying(amount, contractAddress);

    const myContract = new web3.eth.Contract(iface, contractAddress);
    const data = myContract.methods.mint(toMintHex).encodeABI();
    await this.executeTX(contractAddress, data, "0x0", nonce, gasLimit);
  }

  private async borrowCToken(
    sym: string,
    amount: string,
    nonce?: number,
    gasLimit?: number
  ) {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    // TODO: Check the the amount exists in the account
    const toBorrowHex = await this.convertToUnderlying(amount, contractAddress);

    const myContract = new web3.eth.Contract(iface, contractAddress);
    const data = myContract.methods.borrow(toBorrowHex).encodeABI();
    await this.executeTX(contractAddress, data, "0x0", nonce, gasLimit);
  }

  /**
   * Redeem supplied tokens for a cToken contract.
   * cTokens are traded back for regular tokens, according to the exchange rate
   */
  private async redeemCToken(sym: string, amount: string) {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    const toRedeemHex = await this.convertToUnderlying(amount, contractAddress);

    const myContract = new web3.eth.Contract(iface, contractAddress);
    const data = myContract.methods.redeemUnderlying(toRedeemHex).encodeABI();
    this.executeTX(contractAddress, data, "0x0");
  }

  private async convertToUnderlying(
    amount: string,
    contractAddress: string
  ): Promise<string> {
    const base: Decimal = new Decimal(10);
    let underlyingDecimals = await this.getUnderlyingDecimals(contractAddress);
    let coefficient: Decimal = base.pow(underlyingDecimals);
    const decimal: Decimal = coefficient.mul(Number(amount));
    const hex = decimal.toHex();
    return hex;
  }

  //// approve market ///////
  private async approveCToken(
    sym: string,
    amount: string,
    nonce?: number,
    gasLimit?: number
  ) {
    const iface = CTOKEN_JSON_INTERFACE;
    let contractAddress = this.getContractAddress(sym);
    if (contractAddress == "0x0") {
      console.log("No such symbol");
    }
    const underlyingAddress = await this.getUnderlyingAddress(
      iface,
      contractAddress
    );
    const toApproveHex = await this.convertToUnderlying(
      amount,
      contractAddress
    );

    // The transaction to approve is sent to the underlying contract
    const underlyingContract = new web3.eth.Contract(
      ERC20_INERFACE,
      underlyingAddress
    );
    console.log("Underlying", underlyingAddress);
    // Let it controll all your funds
    // const max_val = "0xffffffffffffffffffffffffffffffffffffffff";

    const approveCall = underlyingContract.methods
      .approve(contractAddress, toApproveHex)
      .encodeABI();
    await this.executeTX(
      underlyingAddress,
      approveCall,
      "0x0",
      nonce,
      gasLimit
    );
  }

  /**
   * Restore a client address for DB if exists, or generate a new one
   */
  private async restoreOrGenerate(): Promise<CompAddress> {
    let addr = await this.db.get("address").value();
    if (Object.entries(addr).length === 0 && addr.constructor === Object) {
      return this.generateAddress();
    }
    return CompAddress.fromPlain(addr);
  }

  private async generateAddress(): Promise<CompAddress> {
    let account = await web3.eth.accounts.create();
    let addr = new CompAddress(account.address, account.privateKey);
    this.db.set("address", addr).write();
    return addr;
  }

  private initDb() {
    ensureDirSync(CLIENT_DB_PATH);
    const adapter = new FileSync(`${CLIENT_DB_PATH}/db.json`);
    this.db = low(adapter);
    this.db.defaults().write();
  }

  private async estimateTX(
    contractAddress: string,
    data: string,
    value: string
  ) {
    const nonce = await web3.eth.getTransactionCount(this.address.getAddress());
    let gasPrice = Number(await web3.eth.getGasPrice());
    let gasPriceHex = web3.utils.toHex(gasPrice);

    let gasLimit: number = await web3.eth.estimateGas({
      from: this.address.getAddress(),
      to: contractAddress,
      data: data,
      value: value
    });
    let gasLimitHex = web3.utils.toHex(gasLimit);
    console.log("Gas Price: ", gasPrice);
    console.log("Gas Limit: ", gasLimit);
  }

  private async generateTX(
    contractAddress: string,
    data: string,
    value: string,
    nonce: number,
    gasLimit?: number
  ) {
    let gasPrice = Number(await web3.eth.getGasPrice());
    let gasPriceHex = web3.utils.toHex(gasPrice);

    if (gasLimit == null) {
      gasLimit = await web3.eth.estimateGas({
        from: this.address.getAddress(),
        to: contractAddress,
        data: data,
        value: value
      });
    }
    let gasLimitHex = web3.utils.toHex(gasLimit);

    console.log("Gas Price: ", gasPrice);
    console.log("Gas Limit: ", gasLimit);

    const txParams = {
      nonce,
      gasPrice: gasPriceHex,
      gasLimit: gasLimitHex,
      to: contractAddress,
      data: data,
      value: value
    };
    const tx = new Transaction(txParams, {
      chain: CHAIN
    });
    console.log(`TX: ${tx}`);
    return tx;
  }

  private async signTX(tx: Transaction) {
    console.log("signing tx...");
    // alternatively, we can call `tx.hash()` and sign it using an external signer
    tx.sign(Buffer.from(this.address.getPrivateKey(), "hex"));

    const serializedTx = tx.serialize();

    await web3.eth
      .sendSignedTransaction("0x" + serializedTx.toString("hex"))
      .on("transactionHash", (hash: string) => {
        console.log("-".repeat(20));
        console.log("on(transactionHash): hash =", hash);
      })
      .on("receipt", (receipt: any) => {
        console.log("-".repeat(20));
        console.log("on(receipt): receipt =", receipt);
      })
      .on("error", (error: Error) => {
        console.log("-".repeat(20));
        console.log("on(error): error =", error);
      });
  }

  /**
   * Execute any web3 transaction with passed parameters
   */
  private async executeTX(
    contractAddress: string,
    data: string,
    value: string,
    nonce?: number,
    gasLimit?: number
  ) {
    if (nonce == null) {
      nonce = await web3.eth.getTransactionCount(this.address.getAddress());
    }
    console.log("Nonce: ", nonce);
    let tx = await this.generateTX(
      contractAddress,
      data,
      value,
      nonce,
      gasLimit
    );
    await this.signTX(tx);
  }

  /**
   * Get the address of the underlying ERC20 contract, related to the
   * cToken. Not relevant for ETH
   */
  private async getUnderlyingAddress(
    iface: AbiItem[],
    contractAddress: string
  ): Promise<string> {
    const myContract = new web3.eth.Contract(iface, contractAddress);
    const getUnderlying = myContract.methods.underlying().encodeABI();
    let underlyingAddress = await web3.eth.call({
      to: contractAddress,
      data: getUnderlying
    });

    underlyingAddress = "0x" + underlyingAddress.substr(-40);
    return underlyingAddress;
  }

  private getContractAddress(sym: string): string {
    switch (sym) {
      case "ceth": {
        return config.cETHContract;
        break;
      }
      case "cdai": {
        return config.cDAIContract;
        break;
      }
      case "crep": {
        return config.cREPContract;
        break;
      }
      case "cwbtc": {
        return config.cWBTCContract;
        break;
      }
      case "cusdc": {
        return config.cUSDCContract;
        break;
      }
      case "cbat": {
        return config.cBATContract;
        break;
      }
    }
    return "0x0";
  }
}

function ensureDirSync(dirpath: string) {
  try {
    fs.mkdirSync(dirpath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}
