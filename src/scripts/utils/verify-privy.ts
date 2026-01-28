import { Wallet, JsonRpcProvider, Contract } from 'ethers';
import { CONFIG } from '../../config';
import { ChainId, AddressesByChainId } from '@predictdotfun/sdk';
import dotenv from 'dotenv';
dotenv.config();

async function verifyPrivy() {
    console.log("🔍 Diagnostic: Verifying Predict Account Ownership...");

    const rpcUrl = "https://bsc-dataseed.bnbchain.org/";
    const provider = new JsonRpcProvider(rpcUrl);

    const signer = new Wallet(CONFIG.PRIVATE_KEY, provider);
    console.log(`\n1. Signer Info:`);
    console.log(`   Address: ${signer.address}`);

    const predictAccount = CONFIG.PREDICT_ACCOUNT;
    if (!predictAccount) {
        console.log("\n❌ PREDICT_ACCOUNT is not set in .env");
        return;
    }

    console.log(`\n2. Predict Account (Smart Wallet) Info:`);
    console.log(`   Address: ${predictAccount}`);

    const addresses = AddressesByChainId[CONFIG.CHAIN_ID as ChainId];
    if (!addresses) {
        console.error(`❌ Unsupported Chain ID: ${CONFIG.CHAIN_ID}`);
        return;
    }

    const validatorAddress = addresses.ECDSA_VALIDATOR;
    console.log(`\n3. Chain Info:`);
    console.log(`   Chain ID: ${CONFIG.CHAIN_ID}`);
    console.log(`   ECDSA Validator: ${validatorAddress}`);

    try {
        console.log(`\n4. Preliminary Checks:`);
        const code = await provider.getCode(predictAccount);
        if (code === '0x') {
            console.log(`   ⚠️ WARNING: Predict Account (${predictAccount}) is NOT a contract (EOA?).`);
            console.log(`   👉 Typically, a Smart Account should be a contract.`);
        } else {
            console.log(`   ✅ Success: Predict Account is a contract.`);
        }

        const validator = new Contract(validatorAddress, [
            "function ecdsaValidatorStorage(address account) view returns (address)"
        ], provider);

        console.log(`\n5. Querying Validator Contract...`);
        const owner = await validator.ecdsaValidatorStorage(predictAccount);

        console.log(`   Contract says Owner is: ${owner}`);

        if (owner.toLowerCase() === signer.address.toLowerCase()) {
            console.log("\n✅ SUCCESS: The Signer OWNS this Predict Account.");
        } else if (owner === "0x0000000000000000000000000000000000000000") {
            console.log("\n❌ ERROR: This Predict Account is NOT registered on-chain.");
            console.log("   👉 Are you sure this is the correct Smart Wallet address?");
            console.log("   👉 Did you deploy it on the website yet (by making a trade or deposit)?");
        } else {
            console.log("\n❌ ERROR: Signer Mismatch!");
            console.log(`   The actual owner is: ${owner}`);
            console.log(`   Your signer is: ${signer.address}`);
            console.log("\n   👉 You need the Private Key for the actual owner address shown above.");
        }
    } catch (e: any) {
        console.error(`\n❌ Fatal Error: ${e.message}`);
    }
}

verifyPrivy();
