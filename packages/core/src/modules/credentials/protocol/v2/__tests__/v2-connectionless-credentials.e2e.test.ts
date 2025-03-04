import type { SubjectMessage } from '../../../../../../../../tests/transport/SubjectInboundTransport'
import type { AnonCredsTestsAgent } from '../../../../../../../anoncreds/tests/legacyAnonCredsSetup'
import type { CredentialStateChangedEvent } from '../../../CredentialEvents'
import type { AcceptCredentialOfferOptions, AcceptCredentialRequestOptions } from '../../../CredentialsApiOptions'

import { ReplaySubject, Subject } from 'rxjs'

import { SubjectInboundTransport } from '../../../../../../../../tests/transport/SubjectInboundTransport'
import { SubjectOutboundTransport } from '../../../../../../../../tests/transport/SubjectOutboundTransport'
import {
  getLegacyAnonCredsModules,
  prepareForAnonCredsIssuance,
} from '../../../../../../../anoncreds/tests/legacyAnonCredsSetup'
import { waitForCredentialRecordSubject, getAgentOptions } from '../../../../../../tests/helpers'
import testLogger from '../../../../../../tests/logger'
import { Agent } from '../../../../../agent/Agent'
import { CredentialEventTypes } from '../../../CredentialEvents'
import { AutoAcceptCredential } from '../../../models/CredentialAutoAcceptType'
import { CredentialState } from '../../../models/CredentialState'
import { CredentialExchangeRecord } from '../../../repository/CredentialExchangeRecord'
import { V2CredentialPreview } from '../messages'

const faberAgentOptions = getAgentOptions(
  'Faber connection-less Credentials V2',
  {
    endpoints: ['rxjs:faber'],
  },
  getLegacyAnonCredsModules()
)

const aliceAgentOptions = getAgentOptions(
  'Alice connection-less Credentials V2',
  {
    endpoints: ['rxjs:alice'],
  },
  getLegacyAnonCredsModules()
)

const credentialPreview = V2CredentialPreview.fromRecord({
  name: 'John',
  age: '99',
})

describe('V2 Connectionless Credentials', () => {
  let faberAgent: AnonCredsTestsAgent
  let aliceAgent: AnonCredsTestsAgent
  let faberReplay: ReplaySubject<CredentialStateChangedEvent>
  let aliceReplay: ReplaySubject<CredentialStateChangedEvent>
  let credentialDefinitionId: string

  beforeEach(async () => {
    const faberMessages = new Subject<SubjectMessage>()
    const aliceMessages = new Subject<SubjectMessage>()

    const subjectMap = {
      'rxjs:faber': faberMessages,
      'rxjs:alice': aliceMessages,
    }
    faberAgent = new Agent(faberAgentOptions)
    faberAgent.registerInboundTransport(new SubjectInboundTransport(faberMessages))
    faberAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await faberAgent.initialize()

    aliceAgent = new Agent(aliceAgentOptions)
    aliceAgent.registerInboundTransport(new SubjectInboundTransport(aliceMessages))
    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await aliceAgent.initialize()

    // Create link secret for alice
    await aliceAgent.modules.anoncreds.createLinkSecret({
      linkSecretId: 'default',
      setAsDefault: true,
    })

    const { credentialDefinition } = await prepareForAnonCredsIssuance(faberAgent, {
      attributeNames: ['name', 'age'],
    })
    credentialDefinitionId = credentialDefinition.credentialDefinitionId

    faberReplay = new ReplaySubject<CredentialStateChangedEvent>()
    aliceReplay = new ReplaySubject<CredentialStateChangedEvent>()

    faberAgent.events
      .observable<CredentialStateChangedEvent>(CredentialEventTypes.CredentialStateChanged)
      .subscribe(faberReplay)
    aliceAgent.events
      .observable<CredentialStateChangedEvent>(CredentialEventTypes.CredentialStateChanged)
      .subscribe(aliceReplay)
  })

  afterEach(async () => {
    await faberAgent.shutdown()
    await faberAgent.wallet.delete()
    await aliceAgent.shutdown()
    await aliceAgent.wallet.delete()
  })

  test('Faber starts with connection-less credential offer to Alice', async () => {
    testLogger.test('Faber sends credential offer to Alice')

    // eslint-disable-next-line prefer-const
    let { message, credentialRecord: faberCredentialRecord } = await faberAgent.credentials.createOffer({
      comment: 'V2 Out of Band offer',
      credentialFormats: {
        indy: {
          attributes: credentialPreview.attributes,
          credentialDefinitionId,
        },
      },
      protocolVersion: 'v2',
    })

    const { message: offerMessage } = await faberAgent.oob.createLegacyConnectionlessInvitation({
      recordId: faberCredentialRecord.id,
      message,
      domain: 'https://a-domain.com',
    })

    await aliceAgent.receiveMessage(offerMessage.toJSON())

    let aliceCredentialRecord = await waitForCredentialRecordSubject(aliceReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.OfferReceived,
    })

    testLogger.test('Alice sends credential request to Faber')
    const acceptOfferOptions: AcceptCredentialOfferOptions = {
      credentialRecordId: aliceCredentialRecord.id,
    }
    const credentialRecord = await aliceAgent.credentials.acceptOffer(acceptOfferOptions)

    testLogger.test('Faber waits for credential request from Alice')
    faberCredentialRecord = await waitForCredentialRecordSubject(faberReplay, {
      threadId: credentialRecord.threadId,
      state: CredentialState.RequestReceived,
    })

    testLogger.test('Faber sends credential to Alice')
    const options: AcceptCredentialRequestOptions = {
      credentialRecordId: faberCredentialRecord.id,
      comment: 'V2 Indy Credential',
    }
    faberCredentialRecord = await faberAgent.credentials.acceptRequest(options)

    testLogger.test('Alice waits for credential from Faber')
    aliceCredentialRecord = await waitForCredentialRecordSubject(aliceReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.CredentialReceived,
    })

    testLogger.test('Alice sends credential ack to Faber')
    aliceCredentialRecord = await aliceAgent.credentials.acceptCredential({
      credentialRecordId: aliceCredentialRecord.id,
    })

    testLogger.test('Faber waits for credential ack from Alice')
    faberCredentialRecord = await waitForCredentialRecordSubject(faberReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.Done,
    })

    expect(aliceCredentialRecord).toMatchObject({
      type: CredentialExchangeRecord.type,
      id: expect.any(String),
      createdAt: expect.any(Date),
      metadata: {
        data: {
          '_anonCreds/anonCredsCredential': {
            credentialDefinitionId,
          },
        },
      },
      credentials: [
        {
          credentialRecordType: 'anoncreds',
          credentialRecordId: expect.any(String),
        },
      ],
      state: CredentialState.Done,
      threadId: expect.any(String),
    })

    expect(faberCredentialRecord).toMatchObject({
      type: CredentialExchangeRecord.type,
      id: expect.any(String),
      createdAt: expect.any(Date),
      metadata: {
        data: {
          '_anonCreds/anonCredsCredential': {
            credentialDefinitionId,
          },
        },
      },
      state: CredentialState.Done,
      threadId: expect.any(String),
    })
  })

  test('Faber starts with connection-less credential offer to Alice with auto-accept enabled', async () => {
    // eslint-disable-next-line prefer-const
    let { message, credentialRecord: faberCredentialRecord } = await faberAgent.credentials.createOffer({
      comment: 'V2 Out of Band offer',
      credentialFormats: {
        indy: {
          attributes: credentialPreview.attributes,
          credentialDefinitionId,
        },
      },
      protocolVersion: 'v2',
      autoAcceptCredential: AutoAcceptCredential.ContentApproved,
    })

    const { message: offerMessage } = await faberAgent.oob.createLegacyConnectionlessInvitation({
      recordId: faberCredentialRecord.id,
      message,
      domain: 'https://a-domain.com',
    })

    // Receive Message
    await aliceAgent.receiveMessage(offerMessage.toJSON())

    // Wait for it to be processed
    let aliceCredentialRecord = await waitForCredentialRecordSubject(aliceReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.OfferReceived,
    })

    await aliceAgent.credentials.acceptOffer({
      credentialRecordId: aliceCredentialRecord.id,
      autoAcceptCredential: AutoAcceptCredential.ContentApproved,
    })

    aliceCredentialRecord = await waitForCredentialRecordSubject(aliceReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.Done,
    })

    faberCredentialRecord = await waitForCredentialRecordSubject(faberReplay, {
      threadId: faberCredentialRecord.threadId,
      state: CredentialState.Done,
    })

    expect(aliceCredentialRecord).toMatchObject({
      type: CredentialExchangeRecord.type,
      id: expect.any(String),
      createdAt: expect.any(Date),
      metadata: {
        data: {
          '_anonCreds/anonCredsCredential': {
            credentialDefinitionId: credentialDefinitionId,
          },
        },
      },
      credentials: [
        {
          credentialRecordType: 'anoncreds',
          credentialRecordId: expect.any(String),
        },
      ],
      state: CredentialState.Done,
      threadId: expect.any(String),
    })

    expect(faberCredentialRecord).toMatchObject({
      type: CredentialExchangeRecord.type,
      id: expect.any(String),
      createdAt: expect.any(Date),
      state: CredentialState.Done,
      threadId: expect.any(String),
    })
  })
})
