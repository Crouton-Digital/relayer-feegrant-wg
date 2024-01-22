import axios from 'axios';
import sqlite3 from 'sqlite3';
import config from './config.js';

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Tx } = require('cosmjs-types/cosmos/tx/v1beta1/tx.js');
const { PubKey } = require('cosmjs-types/cosmos/crypto/secp256k1/keys.js');
const { pubkeyToAddress } = require('@cosmjs/amino');

const sqlite = sqlite3.verbose();
const db = new sqlite.Database('./relayerMetrics.db', (err) => {
  if (err) {
    console.error('[ERR] ' + err.message);
  }
  console.log('[INFO] Connected to the relayer metrics SQLite database.');
});

let latestBlockHeight = 0;
let latestBlockTime = "";
let isCatchingUp = true;
let totalGasWanted = 0;
let totalGasUsed = 0;
let totalFee = 0;
let transactionCount = 0;

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS relayer_transactions (
    block_height INTEGER,
    block_time TEXT,
    relayer_address TEXT,
    msg_array TXT,
    gas_wanted INTEGER,
    gas_used INTEGER,
    fee_amount INTEGER,
    gas_price REAL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS total_metrics (
    block_height INTEGER,
    block_time TEXT,
    total_gas_wanted INTEGER,
    total_gas_used INTEGER,
    total_fee INTEGER,
    transaction_count INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS last_block (
    block_height INTEGER,
    block_time TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS grantee_misbehaviors (
    block_height INTEGER,
    block_time TEXT,
    grantee_address TEXT,
    msg_array TEXT
  )`);
});

async function saveTransactionData(blockHeight, blockTime, relayerAddress, msgArray, gasWanted, gasUsed, feeAmount, gasPrice) {
  db.run(`INSERT INTO relayer_transactions (
    block_height, 
    block_time, 
    relayer_address, 
    msg_array, 
    gas_wanted, 
    gas_used, 
    fee_amount, 
    gas_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [
      blockHeight, 
      blockTime, 
      relayerAddress, 
      msgArray, 
      gasWanted, 
      gasUsed, 
      feeAmount, 
      gasPrice
    ], (err) => {
      if (err) {
        console.error('[ERR] ' + err.message);
      }
  });
  console.log(`[DEBUG] saved relayer_transaction for: ${relayerAddress}`);
  return;
}

async function saveTotalMetricsData(blockHeight, blockTime, totalGasWanted, totalGasUsed, totalFee, transactionCount) {
  db.run(`INSERT INTO total_metrics (
    block_height, 
    block_time, 
    total_gas_wanted, 
    total_gas_used, 
    total_fee, 
    transaction_count
    ) VALUES (?, ?, ?, ?, ?, ?)`, 
    [
      blockHeight, 
      blockTime, 
      totalGasWanted, 
      totalGasUsed, 
      totalFee, 
      transactionCount
    ], (err) => {
      if (err) {
        console.error('[ERR] ' + err.message);
      }
  });
  console.log(`[DEBUG] saved total_metrics.`);
  return;
}

async function saveLastBlockData(blockHeight, blockTime) {
  db.run(`INSERT INTO last_block (
    block_height, 
    block_time
    ) VALUES (?, ?)`, 
    [
      blockHeight, 
      blockTime
    ], (err) => {
      if (err) {
        console.error('[ERR] ' + err.message);
      }
  });
  return;
}

async function saveGranteeMisbehaviorData(blockHeight, blockTime, granteeAddress, msgTypes) {
  db.run(`INSERT INTO grantee_misbehaviors (
    block_height, 
    block_time, 
    grantee_address, 
    msg_array
    ) VALUES (?, ?, ?, ?)`, 
    [
      blockHeight, 
      blockTime, 
      granteeAddress, 
      msgTypes
    ], (err) => {
      if (err) {
        console.error('[ERR] ' + err.message);
      }
  });
  return;
}

async function getLatestBlockHeightFromDB() {
  try {
    const row = await new Promise((resolve, reject) => {
      db.get("SELECT MAX(block_height) as max_height FROM last_block", (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
    return row ? row.max_height : config.indexer_start_block_height;
  } catch (error) {
    console.error('[ERR] Error fetching latest block height from database:', error);
    return false;
  }
}

async function getBlock(height) {
  try {
    const response = await axios.get(`${config.rpc_url}/block?height=${height}`);
    return response.data.result.block;
  } catch (error) {
    console.error(`[ERR] Error fetching block at height ${height}:`, error);
    return null;
  }
}

function deriveAddressFromPubkey(pubkeyValue) {
  let key = PubKey.toJSON(PubKey.decode(pubkeyValue)).key.toString();
  let pubkey = {
      "type": "tendermint/PubKeySecp256k1",
      "value": key
  }
  return pubkeyToAddress(pubkey, config.addr_prefix);
}

async function processTransaction(tx) {
  try {
    let buff = Buffer.from(tx, 'base64');
    let txDecoded = Tx.decode(buff);
    let isRelayerTx = false;
    let typeArray = [];

    txDecoded.body.messages.forEach((msg) => {
      typeArray.push(msg.typeUrl)
      if (msg.typeUrl.includes('/ibc') && msg.typeUrl != "/ibc.applications.transfer.v1.MsgTransfer") {
        isRelayerTx = true;
      }
    });

    if (isRelayerTx && txDecoded.authInfo.fee.granter == config.granter_address) {
      // This is regular relaying transaction using the granter
      const gasWanted = parseInt(txDecoded.authInfo.fee.gasLimit || '0', 10);
      const gasUsed = parseInt(txDecoded.authInfo.fee.gasUsed || '0', 10); // this always returns zero: how do we correctly get the gas used for the tx?
      const feeAmount = parseInt(txDecoded.authInfo.fee.amount?.[0]?.amount || '0');
      const gasPrice = feeAmount / gasWanted;

      const relayerAdress = deriveAddressFromPubkey(txDecoded.authInfo.signerInfos[0].publicKey.value);

      await saveTransactionData(
        parseInt(latestBlockHeight), 
        latestBlockTime,
        relayerAdress,
        JSON.stringify(typeArray),
        gasWanted,
        gasUsed,
        feeAmount,
        gasPrice
      );

      totalGasWanted += gasWanted;
      totalGasUsed += gasUsed;
      totalFee += parseInt(feeAmount, 10);
      transactionCount++;
      return true;
    } 
    if (!isRelayerTx && txDecoded.authInfo.fee.granter == config.granter_address) {
      // This is a misbehaving transaction using the granter
      const granteeAddress = deriveAddressFromPubkey(txDecoded.authInfo.signerInfos[0].publicKey.value);
      const typeString = '[' + typeArray.map(type => `"${type}"`).join(', ') + ']';

      await saveGranteeMisbehaviorData(
        parseInt(latestBlockHeight), 
        latestBlockTime, 
        granteeAddress,
        typeString
      );

      granteeTotalMisbehaviourTxs.labels(granteeAddress, typeString).inc();
    }
  } catch (error) {
    console.error('[ERR] Error processing transaction:', error);
  }
  return false;
}

async function processBlock(blockData) {
  let txs = blockData.txs;
  let blockHasRelayerTx = false;
  let isRelayerTx = false;
  if (txs) {
    for (const tx of txs) {
      isRelayerTx = await processTransaction(tx);
      if (isRelayerTx) {
        blockHasRelayerTx = true;
      }
    };
  }
  if (blockHasRelayerTx) {
    await saveTotalMetricsData(
      parseInt(latestBlockHeight),
      latestBlockTime,
      totalGasWanted,
      totalGasUsed,
      totalFee,
      transactionCount
    );
    
    totalGasWanted = 0;
    totalGasUsed = 0;
    totalFee = 0;
    transactionCount = 0;
  }

  return;
}

async function updateLatestBlockHeight() {
  try {
    const response = await axios.get(`${config.rpc_url}/block`);
    latestBlockHeight = parseInt(response.data.result.block.header.height);
    latestBlockTime = response.data.result.block.header.time;
  } catch (error) {
    console.error('[ERR] Error fetching latest block height:', error);
  }
}

export async function indexer() {
  let currentHeight = await getLatestBlockHeightFromDB();
  if (!currentHeight || currentHeight == 0) {
    console.log('[INFO] Starting indexer from start height: ' + config.indexer_start_block_height);
    currentHeight = parseInt(config.indexer_start_block_height);
  } else {
    console.log('[INFO] Found db entry with height ' + currentHeight + '. Starting indexer.');
    currentHeight++;
  }

  while (isCatchingUp) {
    try {
      const block = await getBlock(currentHeight);
      if (block) {
        await processBlock(block.data);
      }
      await saveLastBlockData(block.header.height, block.header.time);
      console.log('[INFO] processed block: ' + block.header.height + ', header_time: ' + block.header.time);
    } catch (e) {
      console.error('[ERR] ' + e);
    }
    await updateLatestBlockHeight();
    if (currentHeight == latestBlockHeight) {
      isCatchingUp = false;
    }  
    currentHeight++;  
  }

  console.log('[INFO] Indexer caught up, swiching to polling mode.')

  // Polling for new blocks
  setInterval(async () => {
    await updateLatestBlockHeight();
    if (currentHeight <= latestBlockHeight) {
      const block = await getBlock(currentHeight);
      if (block) {
        await processBlock(block.data);
      }   
      await saveLastBlockData(block.header.height, block.header.time);
      console.log('[INFO] processed block: ' + block.header.height + ', header_time: ' + block.header.time);
      currentHeight++;
    }
  }, config.indexer_poll_frequency); 
}

process.on('exit', () => {
  db.close((err) => {
    if (err) {
      console.error('[ERR] ' + err.message);
    }
    console.log('[INFO] Close the database write connection.');
  });
});