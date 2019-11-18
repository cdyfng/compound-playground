const EthereumTx = require("ethereumjs-tx").Transaction;
import Web3 from "web3";
const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://ropsten.infura.io/v3/3d93a3a00252437cb50e9a81ad147c99"
  )
);
import { config } from "./config";
import { CETH_JSON_INTERFACE } from "./cEth-interface";

const myContract = new web3.eth.Contract(
  CETH_JSON_INTERFACE,
  config.cETHContract
);

const payableAmount: number = 0.01;
const data = myContract.methods.mint().encodeABI();
console.log("data =", data);

(async function mintCEther() {
  const nonce = await web3.eth.getTransactionCount(config.senderAddress);
  let gasPrice = Number(await web3.eth.getGasPrice());
  console.log("gasPrice =", gasPrice);
  let gasPriceHex = web3.utils.toHex(gasPrice);
  console.log("gasPrice #2 =", gasPriceHex);

  let gasLimit: number = await web3.eth.estimateGas({
    from: config.senderAddress,
    to: config.cETHContract,
    data
  });
  console.log("gasLimit =", gasLimit);
  let gasLimitHex = web3.utils.toHex(gasLimit * 2);
  console.log("gasLimit #2 =", gasLimitHex);

  let balance = await web3.eth.getBalance(config.senderAddress);
  console.log(`Balance ${balance}`);

  const toMint = Number(web3.utils.toWei("0.001", "ether"));
  const toMintHex = `0x${toMint.toString(16)}`;
  console.log(`To mint ${toMintHex}`);

  const txParams = {
    nonce,
    gasPrice: gasPriceHex,
    gasLimit: gasLimitHex,
    to: config.cETHContract,
    data,
    value: toMintHex
  };
  const tx = new EthereumTx(txParams, {
    chain: "ropsten"
  });
  console.log(`TX: ${tx}`);

  console.log("signing tx...");
  // alternatively, we can call `tx.hash()` and sign it using an external signer
  tx.sign(Buffer.from(config.senderPrivateKey, "hex"));

  const serializedTx = tx.serialize();
  console.log("serializedTx =", serializedTx.toString("hex"));

  web3.eth
    .sendSignedTransaction("0x" + serializedTx.toString("hex"))
    .on("transactionHash", (hash: string) => {
      console.log("-".repeat(20));
      console.log("on(transactionHash): hash =", hash);
    })
    .on("receipt", (receipt: any) => {
      console.log("-".repeat(20));
      console.log("on(receipt): receipt =", receipt);
    })
    .on("confirmation", (confirmation: number, receipt: any) => {
      console.log("-".repeat(20));
      console.log("on(confirmation): confirmation =", confirmation);
      console.log("on(confirmation): receipt =", receipt);
    })
    .on("error", (error: Error) => {
      console.log("-".repeat(20));
      console.log("on(error): error =", error);
    });
})();
