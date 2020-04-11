import { parseISO, format, subMonths } from 'date-fns'
import plaid, { TransactionsResponse } from 'plaid'
import { Config, updateConfig } from '../../lib/config'
import { PlaidConfig, PlaidEnvironmentType } from '../../types/integrations/plaid'
import { IntegrationId } from '../../types/integrations'
import express from 'express'
import bodyParser from 'body-parser'
import { logInfo, logError, logWarn } from '../../lib/logging'
import http from 'http'
import { AccountConfig, Account } from '../../types/account'
import { Transaction } from '../../types/transaction'

export class PlaidIntegration {
    config: Config
    plaidConfig: PlaidConfig
    environment: string
    client: plaid.Client

    constructor(config: Config) {
        this.config = config
        this.plaidConfig = this.config.integrations[IntegrationId.Plaid] as PlaidConfig

        this.environment =
            this.plaidConfig.environment === PlaidEnvironmentType.Development
                ? plaid.environments.development
                : plaid.environments.sandbox

        this.client = new plaid.Client(
            this.plaidConfig.credentials.clientId,
            this.plaidConfig.credentials.secret,
            this.plaidConfig.credentials.publicKey,
            this.environment,
            {
                version: '2019-05-29'
            }
        )
    }

    public addAccount = (): Promise<{
        message?: string
        error?: any
    }> => {
        return new Promise((resolve, reject) => {
            const client = this.client
            const app = express()
            app.use(bodyParser.json())
            app.use(bodyParser.urlencoded({ extended: true }))
            let server: http.Server

            app.post('/get_access_token', function(req, res) {
                const body = req.body
                if (body.public_token !== undefined) {
                    client.exchangePublicToken(body.public_token, function(error, tokenResponse) {
                        if (error != null) {
                            reject({
                                message: 'Encountered error exchanging Plaid public token.',
                                error
                            })
                        }

                        updateConfig(config => {
                            config.accounts[tokenResponse.item_id] = {
                                id: tokenResponse.item_id,
                                integration: IntegrationId.Plaid,
                                token: tokenResponse.access_token
                            }
                            this.config = config
                            return config
                        })

                        resolve({
                            message: 'Plaid access token saved.'
                        })
                        server.close()
                        return res.json({})
                    })
                } else if (body.exit !== undefined) {
                    reject({ error: 'Plaid authentication cancelled.' })
                    server.close()
                    return res.json({})
                } else {
                    reject({ message: 'Encountered error during authentication.', error: body.error })
                    server.close()
                    return res.json({})
                }
            })

            app.get('/', function(req, res) {
                res.sendFile(__dirname + '/addAccount.html')
            })

            server = require('http').createServer(app)
            server.listen('8000')
        })
    }

    public fetchPagedTransactions = async (
        accountConfig: AccountConfig,
        startDate: Date,
        endDate: Date
    ): Promise<TransactionsResponse> => {
        return new Promise(async (resolve, reject) => {
            try {
                const dateFormat = 'yyyy-MM-dd'
                const start = format(startDate, dateFormat)
                const end = format(endDate, dateFormat)

                let options: plaid.TransactionsRequestOptions = { count: 500, offset: 0 }
                let accounts = await this.client.getTransactions(accountConfig.token, start, end, options)

                while (accounts.transactions.length < accounts.total_transactions) {
                    options.offset += options.count
                    const next_page = await this.client.getTransactions(accountConfig.token, start, end, options)
                    accounts.transactions = accounts.transactions.concat(next_page.transactions)
                }

                return resolve(accounts)
            } catch (e) {
                return reject(e)
            }
        })
    }

    public fetchAccount = async (accountConfig: AccountConfig, startDate: Date, endDate: Date): Promise<Account[]> => {
        if (startDate < subMonths(new Date(), 5)) {
            logWarn('Note: Plaid transaction history older than 6 months may not be available for some institutions.', {})
        }

        return this.fetchPagedTransactions(accountConfig, startDate, endDate)
            .then(data => {
                let accounts: Account[] = data.accounts.map(account => ({
                    integration: IntegrationId.Plaid,
                    accountId: account.account_id,
                    mask: account.mask,
                    institution: account.name,
                    account: account.official_name,
                    type: account.subtype || account.type,
                    current: account.balances.current,
                    available: account.balances.available,
                    limit: account.balances.limit,
                    currency: account.balances.iso_currency_code || account.balances.unofficial_currency_code
                }))

                const transactions: Transaction[] = data.transactions.map(transaction => ({
                    integration: IntegrationId.Plaid,
                    name: transaction.name,
                    date: parseISO(transaction.date),
                    amount: transaction.amount,
                    currency: transaction.iso_currency_code || transaction.unofficial_currency_code,
                    type: transaction.transaction_type,
                    accountId: transaction.account_id,
                    transactionId: transaction.transaction_id,
                    category: transaction.category.join(' - '),
                    address: transaction.location.address,
                    city: transaction.location.city,
                    state: transaction.location.region,
                    postal_code: transaction.location.postal_code,
                    country: transaction.location.country,
                    latitude: transaction.location.lat,
                    longitude: transaction.location.lon,
                    pending: transaction.pending
                }))

                accounts = accounts.map(account => ({
                    ...account,
                    transactions: transactions
                        .filter(transaction => transaction.accountId === account.accountId)
                        .map(transaction => ({
                            ...transaction,
                            institution: account.institution,
                            account: account.account
                        }))
                }))

                logInfo(
                    `Fetched ${data.accounts.length} sub-accounts and ${data.total_transactions} transactions for account ${accountConfig.id} using ${accountConfig.integration}.`,
                    accounts
                )
                return accounts
            })
            .catch(error => {
                logError(`Error fetching account ${accountConfig.id} using ${accountConfig.integration}.`, error)
                return []
            })
    }
}

// // Exchange an expired API access_token for a new Link public_token
// const createPublicToken = (access_token, accountNickname) =>
//   PLAID_CLIENT.createPublicToken(access_token).then(tokenResponse => {
//     return tokenResponse.public_token
//   })

//   // Handle category overrides defined in config
//   if (process.env.CATEGORY_OVERRIDES) {
//     // Handle corner case where this was set before v1.0.0 & scripts/migrate.js double escapes it
//     categoryOverrides =
//       typeof process.env.CATEGORY_OVERRIDES === 'string'
//         ? JSON.parse(process.env.CATEGORY_OVERRIDES)
//         : process.env.CATEGORY_OVERRIDES

//     transactions = _.map(transactions, transaction => {
//       _.forEach(categoryOverrides, override => {
//         if (new RegExp(override.pattern, _.get(override, 'flags', '')).test(transaction.name)) {
//           transaction['category.0'] = _.get(override, 'category.0', '')
//           transaction['category.1'] = _.get(override, 'category.1', '')
//         }
//       })
//       return transaction
//     })
//   }
