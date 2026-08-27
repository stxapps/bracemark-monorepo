import type { Metadata } from 'next';
import Link from 'next/link';

import { PLAN_LABELS, TRIAL_DAYS } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import { COMPANY, SOURCE, SUPPORT_EMAIL, TERMS_UPDATED } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms you agree to when you use Bracemark.',
};

// Both Apple and Google require a reachable terms URL on the listing, and the
// listings are what lock the bundle ID in — so this route has to
// carry real content before submission, not a placeholder.
//
//
// The company name and postal address come from `COMPANY` in lib/site.ts.
//
// THE NOTICE CHANNEL IS THIS WEBSITE, and only this website. Three sentences here
// used to name the app as a place we give notice — a change to the Service, a
// material revision to these Terms, and the general clause that stands in for the
// email address we do not hold. Neither client has an announcement surface, a
// what's-new pane or a banner slot, so the one clause a reader is asked to AGREE to
// ("you agree that notice given that way reaches you") named a way we cannot give
// it. /privacy dropped the same promise in the same change. If an in-app notice
// ever ships, these are the sentences that may widen again — not before.
//
// The markup is plain h2/h3/p/ol under `.legal-prose` (globals.css) on purpose:
// this document gets edited under time pressure while answering a reviewer, and
// it has to stay readable as prose rather than as a wall of class names.
export default function Page() {
  const company = COMPANY.legalName;

  return (
    <PageShell
      eyebrow="Legal"
      title="Terms of Service"
      lede={`The agreement between you and ${company} for the use of Bracemark.`}
      meta={`Last updated ${TERMS_UPDATED}`}
      width="document"
    >
      <div className={cn('legal-prose')}>
        <p>
          These Terms of Service (“Terms”) govern your access to and use of the Bracemark website at
          bracemark.com and app.bracemark.com, the Bracemark applications for iOS, Android, Chrome
          and Firefox, and any related services (together, the “Service”), all provided by {company}{' '}
          (“{COMPANY.shortName}”, “we”, “us”).
        </p>
        <p>
          By creating an account, or by otherwise accessing or using the Service, you agree to be
          bound by these Terms. If you do not agree to them, please stop using the Service and
          uninstall the applications. Our <Link href="/privacy">Privacy Policy</Link> explains how
          we handle information and forms part of this agreement.
        </p>
        <p>
          <strong>Please read the Disputes section below before you agree.</strong> It sends most
          disputes to individual arbitration rather than to a court, and it waives class actions and
          jury trials. You can opt out of it within thirty days and keep everything else, and it
          does not touch the rights your local consumer law gives you.
        </p>

        <h2>Who may use the Service</h2>
        <p>
          You must be at least 13 years old to use the Service, and old enough to form a binding
          contract where you live. If you use the Service on behalf of an organisation, you confirm
          that you are authorised to accept these Terms for it.
        </p>

        <h2>Your licence to use the Service</h2>
        <p>
          Subject to your compliance with these Terms, {COMPANY.shortName} grants you a limited,
          non-exclusive, non-transferable, non-sublicensable and revocable licence to use the
          Service, and to install and use the applications on devices you own or control, for your
          own personal or internal business use.
        </p>
        <p>
          Your licence to any application you download from an app store is also governed by that
          store’s own terms (the “App Store Terms”). Where these Terms conflict with the applicable
          App Store Terms, the App Store Terms prevail for that application. Download the
          applications only from the stores through which we publish them.
        </p>
        <p>
          We may suspend or terminate your licence, or any part of the Service, if you breach these
          Terms or the acceptable-use rules below. On termination, the rights granted to you end and
          you must stop using the Service; the sections that by their nature should survive —
          including those covering our content, disclaimers, liability, indemnity and disputes —
          continue to apply.
        </p>
        <p>
          You can end this agreement whenever you like: stop using the Service and uninstall the
          applications, or delete your account from Settings → Account, which removes what we hold
          for it. Deleting an account does not cancel a subscription — see{' '}
          <em>Plans, fees and subscriptions</em> below.
        </p>

        <h2>Your account, your password and your key</h2>
        <p>
          A Bracemark account is a username and a password. We do not ask for an email address or
          any other personal identifier, and there is no account-verification step.
        </p>
        <p>
          <strong>Your password derives the key that encrypts your data.</strong> That derivation
          happens on your device. Neither your password nor the key it produces is ever sent to us,
          and we have no copy of either. This has consequences you must accept before you use the
          Service:
        </p>
        <ol>
          <li>
            <strong>We cannot reset your password and we cannot recover your data.</strong> If you
            lose your password and have not saved a recovery code, your saved links cannot be
            decrypted by anyone — including us. This is not a support matter that can be escalated.
          </li>
          <li>
            <strong>A recovery code is your second way in.</strong> The Service can generate one
            when you create your account, and you can generate or replace one later. It is shown
            once. Storing it somewhere safe, and separately from your password, is your
            responsibility.
          </li>
          <li>
            <strong>Anyone with your password or recovery code has your library.</strong> You are
            responsible for keeping both secret and for all activity under your account, whether or
            not you authorised it. Tell us promptly if you believe either has been exposed.
          </li>
        </ol>
        <p>
          Usernames are unique and, once an account is deleted, the username is retired rather than
          released for reuse. Some usernames are reserved so that no account can appear to speak for
          Bracemark or for a system role.
        </p>

        <h2>Your content</h2>
        <p>
          The links you save, and everything you record about them, remain yours. You grant us no
          licence over their contents, and we could not exercise one if you did: we hold them only
          as encrypted files that we have no means of reading.
        </p>
        <p>
          You are responsible for what you save and for having the right to save it, including
          anything a save captures from the page it points to. You should assume that a saved link
          is a pointer, and that the page behind it may change or disappear at any time.
        </p>
        <p>
          Export your data at any time, on any plan, using the export feature in the app. We
          recommend keeping your own backups: our storage is redundant, but it is not a substitute
          for a copy you control.
        </p>
        <p>
          If you have not signed in or used your account for at least two years, we reserve the
          right to delete the data stored for it, in order not to hold encrypted data indefinitely
          for accounts that have been abandoned.
        </p>

        <h2>Feedback</h2>
        <p>
          If you send us an idea, a bug report or a suggestion, you give us permission to use it —
          in any way, anywhere, without payment, attribution or any obligation of confidence. Please
          do not send us anything you consider secret or that belongs to someone else. This says
          nothing about the links and notes in your library, which are covered by{' '}
          <em>Your content</em> above.
        </p>

        <h2>Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>
            use the Service to store or distribute material that is unlawful where you are, or that
            infringes someone else’s rights;
          </li>
          <li>
            attempt to gain unauthorised access to any account, system or data, or to circumvent any
            limit, quota or entitlement in the Service;
          </li>
          <li>
            interfere with the operation of the Service, including by automated request volumes that
            degrade it for others, or by using the link-extraction service to fetch pages at a scale
            or for a purpose it is not intended for;
          </li>
          <li>
            resell or commercially redistribute access to the Service we operate, or to the accounts
            on it. This is a restriction on the hosted service, not on the source code — what you
            may do with the code is set by its licence, described under{' '}
            <em>Our content, the source code and trademarks</em> below.
          </li>
        </ul>
        <p>
          We may rate-limit, suspend or terminate access that we reasonably believe breaches these
          rules or threatens the stability of the Service.
        </p>

        <h2>Copyright and other complaints</h2>
        <p>
          If you believe material on the Service infringes your copyright or another right, write to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with enough detail to identify the
          material, the right you hold, and how to reach you. Please understand what we are able to
          do before you write: a library is encrypted with a key we do not have, so we cannot search
          it, read it, or remove one saved link from it. What we can do is act on the account —
          including suspending or terminating the accounts of repeat infringers — and comply with a
          valid legal order.
        </p>

        <h2>Plans, fees and subscriptions</h2>
        <p>
          The Service has a free plan and one or more paid plans. The features and limits of each
          are described on our <Link href="/pricing">pricing page</Link>. We may change what the
          plans include; where a change would materially reduce what you have already paid for, it
          will not take effect until your current paid period ends.
        </p>
        <p>
          Prices are stated in US dollars and may be presented to you in your local currency, with
          any applicable taxes calculated at checkout. Paid plans purchased on the web are sold
          through Paddle, which acts as the merchant of record for that sale; purchases made inside
          the iOS or Android applications are sold through Apple or Google under their terms. We
          never receive or store your payment card details.
        </p>
        <p>If you purchase a subscription or start a trial, the following apply:</p>
        <ol>
          <li>
            <strong>Free trial.</strong> Where a trial is offered it lasts {TRIAL_DAYS} days and
            applies to the annual {PLAN_LABELS.plus} plan. Unless you cancel before it ends, it
            converts into a paid subscription and the first payment is taken.
          </li>
          <li>
            <strong>Auto-renewal.</strong> Subscriptions renew automatically for successive periods
            of the same length, at the then-current price plus any applicable taxes, until you
            cancel. Paddle emails a receipt for each web renewal to the address you gave it, and
            Apple and Google notify you through their own channels — we hold no email address to
            write to. Deleting your account does not cancel a subscription: cancel it through the
            provider you bought it from.
          </li>
          <li>
            <strong>Cancellation.</strong> You may cancel at any time: through the Paddle customer
            portal for a web purchase, or through the App Store or Google Play for a purchase made
            in those apps. Access to paid features continues until the end of the period you have
            already paid for.
          </li>
          <li>
            <strong>Refunds.</strong> Refunds for web purchases are handled by Paddle, and refunds
            for store purchases by Apple or Google, under their respective policies. If you are a
            consumer in the EU or the UK you may also have a statutory right to withdraw within
            fourteen days of the contract being formed. If something has gone wrong with a payment,
            write to us at {SUPPORT_EMAIL} and we will help.
          </li>
        </ol>
        <p>
          If we stop offering a paid plan for reasons within our control, we will cancel affected
          subscriptions and refund the unused portion of any period already paid for. If payment
          fails, access to paid features may be suspended after a grace period; your data is never
          deleted for non-payment, and your library remains readable and exportable on the free
          plan.
        </p>

        <h2>Changes to the Service</h2>
        <p>
          We may modify, suspend or discontinue any part of the Service. Where a change is
          significant and affects a paid plan, we will give reasonable notice on this website.
        </p>

        <h2>Changes to these Terms</h2>
        <p>
          We may revise these Terms from time to time. The date at the top of this page shows when
          they last changed, and continuing to use the Service after a revision means you accept the
          revised Terms. Where a change is material we will make reasonable efforts to highlight it
          on this website.
        </p>

        <h2>Our content, the source code and trademarks</h2>
        <p>
          {COMPANY.shortName} and its licensors own the Service, the applications, and the software,
          designs and other materials that make them up, together with all associated intellectual
          property rights. Except for the rights granted by the source-code licence described below,
          the Service is licensed to you rather than sold, and we reserve all rights not expressly
          granted in these Terms.
        </p>
        <p>
          <strong>The software behind Bracemark is published as open source</strong>, under the{' '}
          {SOURCE.license}, at{' '}
          <a href={SOURCE.url} rel="noreferrer">
            {SOURCE.label}
          </a>
          . That licence — not these Terms — sets out what you may do with the source code,
          including reading, modifying, and redistributing it on its conditions. Where these Terms
          and that licence disagree about your rights in the source code, that licence prevails.
          These Terms govern your use of the service we host and of the applications we publish, and
          nothing in the licence entitles you to use those.
        </p>
        <p>
          The name “Bracemark”, the Bracemark logo and the Bracemark app icon are ours, and the
          source-code licence does not grant you any right to use them. If you publish or operate a
          modified version, please give it a different name and icon — so that no one can mistake it
          for the service we run. Other names and logos appearing in the Service belong to their
          respective owners, who may have no connection with us.
        </p>

        <h2>Third-party materials</h2>
        <p>
          The Service stores and displays links to websites and services that we do not control. We
          do not endorse them and we are not responsible for their content, their terms or their
          privacy practices, and we are not liable for any loss arising from your use of or reliance
          on them.
        </p>

        <h2>System requirements</h2>
        <p>
          Using the Service requires a compatible device, internet access, and up-to-date software,
          any of which may carry their own costs. Because the Service is local-first, it also uses
          storage on your device to hold your library. Meeting these requirements is your
          responsibility, and they may change over time.
        </p>

        <h2>Accessibility</h2>
        <p>
          We build the Service to work with a screen reader, with a keyboard alone, and at the text
          size you have chosen, and we aim to meet the Web Content Accessibility Guidelines 2.1 at
          level AA. We do not claim to have got everything right. If some part of the Service is
          unusable for you, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and
          tell us what and where — we treat those reports as faults, not as feature requests.
        </p>

        <h2>Disclaimer of warranties</h2>
        <p className={cn('caps')}>
          THE SERVICE IS PROVIDED “AS IS”, “WITH ALL FAULTS” AND “AS AVAILABLE”. TO THE FULLEST
          EXTENT PERMITTED BY LAW, {company.toUpperCase()} AND ITS AFFILIATES, OFFICERS, DIRECTORS,
          EMPLOYEES, AGENTS, PARTNERS AND LICENSORS (THE “{COMPANY.shortName.toUpperCase()}{' '}
          PARTIES”) DISCLAIM ALL WARRANTIES AND CONDITIONS OF ANY KIND, EXPRESS, IMPLIED OR
          STATUTORY, INCLUDING THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
          PURPOSE, NON-INFRINGEMENT, INTEROPERABILITY AND QUIET ENJOYMENT. WE DO NOT WARRANT THAT
          THE SERVICE WILL BE UNINTERRUPTED, TIMELY, SECURE OR ERROR-FREE, THAT DEFECTS WILL BE
          CORRECTED, OR THAT ANY DATA WILL BE PRESERVED WITHOUT LOSS. SOME JURISDICTIONS DO NOT
          ALLOW THE EXCLUSION OF IMPLIED WARRANTIES, SO PARTS OF THIS SECTION MAY NOT APPLY TO YOU,
          AND NOTHING IN THESE TERMS AFFECTS CONSUMER RIGHTS THAT CANNOT BE WAIVED.
        </p>

        <h2>Limitation of liability</h2>
        <p className={cn('caps')}>
          TO THE FULLEST EXTENT PERMITTED BY LAW, THE {COMPANY.shortName.toUpperCase()} PARTIES
          SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE
          DAMAGES, OR FOR ANY LOSS OF PROFITS, GOODWILL, USE OR DATA, ARISING OUT OF OR RELATED TO
          YOUR USE OF OR INABILITY TO USE THE SERVICE, WHETHER OR NOT WE HAVE BEEN ADVISED THAT SUCH
          DAMAGES ARE POSSIBLE. IN PARTICULAR, AND WITHOUT LIMITING THE ABOVE, THE{' '}
          {COMPANY.shortName.toUpperCase()} PARTIES ARE NOT LIABLE FOR DATA THAT CANNOT BE DECRYPTED
          BECAUSE A PASSWORD OR RECOVERY CODE HAS BEEN LOST. OUR TOTAL LIABILITY FOR ALL CLAIMS
          RELATING TO THE SERVICE SHALL NOT EXCEED THE GREATER OF THE AMOUNT YOU PAID US IN THE
          TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR USD 50. SOME JURISDICTIONS DO
          NOT ALLOW THE EXCLUSION OR LIMITATION OF CERTAIN DAMAGES, SO PARTS OF THIS SECTION MAY NOT
          APPLY TO YOU.
        </p>

        <h2>Indemnification</h2>
        <p>
          You agree to indemnify and hold the {COMPANY.shortName} Parties harmless from any claims,
          losses, liabilities and expenses (including reasonable legal fees) arising out of your use
          of the Service, your content, your breach of these Terms, or your violation of any law or
          of anyone else’s rights. We may assume the exclusive defence of any matter subject to this
          indemnity, and you agree to cooperate with it.
        </p>

        <h2>Disputes</h2>
        <p>
          If a dispute arises out of or relating to these Terms, please contact us first at{' '}
          {SUPPORT_EMAIL} — most things are resolved that way. If we cannot resolve it:
        </p>
        <ol>
          <li>
            <strong>Negotiation.</strong> The parties will attempt in good faith to resolve the
            dispute by negotiation within thirty days of written notice.
          </li>
          <li>
            <strong>Mediation.</strong> Failing that, the parties will attempt mediation, before a
            mediator they agree on or, failing agreement, one appointed by the Thailand Arbitration
            Center.
          </li>
          <li>
            <strong>Arbitration.</strong> Any dispute not resolved by negotiation or mediation shall
            be settled by final and binding arbitration under the rules of the Thailand Arbitration
            Center, seated in Bangkok, before one or more neutral arbitrators.
          </li>
        </ol>
        <p className={cn('caps')}>
          ANY ARBITRATION UNDER THIS SECTION IS ON AN INDIVIDUAL BASIS ONLY. YOU AND{' '}
          {COMPANY.shortName.toUpperCase()} EACH WAIVE THE RIGHT TO A TRIAL BY JURY AND THE RIGHT TO
          BRING OR TAKE PART IN ANY CLASS, COLLECTIVE OR REPRESENTATIVE PROCEEDING. AN ARBITRATOR
          MAY AWARD RELIEF ONLY TO THE INDIVIDUAL PARTY SEEKING IT. IF THIS PARAGRAPH IS HELD
          UNENFORCEABLE FOR A PARTICULAR CLAIM, THAT CLAIM SHALL BE HEARD IN COURT AND THE REST OF
          THIS SECTION STILL APPLIES TO EVERY OTHER CLAIM.
        </p>
        <p>
          <strong>You can opt out of arbitration.</strong> Write to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> within thirty days of first
          accepting these Terms, with your username if you have one and a clear statement that you
          are opting out. Opting out costs you nothing, changes nothing else in these Terms, and we
          will not treat it as a reason to close your account.
        </p>
        <p>
          Nothing in this section prevents either party from bringing an individual claim in a
          small-claims court that has jurisdiction over it, from seeking urgent injunctive relief
          from a competent court, or affects any right you have as a consumer to bring proceedings
          in the courts of your country of residence where local law gives you that right.
        </p>

        <h2>Notice for California residents</h2>
        <p>
          Under California Civil Code section 1789.3, California users of the Service are entitled
          to this notice. The provider of the Service is {company},{' '}
          {COMPANY.addressLines.join(', ')}. To file a complaint about the Service, or to ask for
          more information about it, write to that address or to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. You may also contact the
          Complaint Assistance Unit of the Division of Consumer Services of the California
          Department of Consumer Affairs at 1625 N. Market Blvd., Suite N112, Sacramento, CA 95834,
          or by telephone at (800) 952-5210. Our <Link href="/privacy">Privacy Policy</Link>{' '}
          describes the privacy rights California law gives you and how to use them.
        </p>

        <h2>Governing law</h2>
        <p>
          These Terms and any dispute arising from them are governed by the laws of the Kingdom of
          Thailand, without regard to its conflict-of-laws rules, and the competent courts of
          Thailand have jurisdiction — subject in each case to any mandatory consumer protections
          that apply where you live.
        </p>

        <h2>General</h2>
        <p>
          If any provision of these Terms is held to be invalid or unenforceable, it will be limited
          or removed to the minimum extent necessary and the rest will remain in force. Our failure
          to enforce a provision is not a waiver of it. You may not assign your rights under these
          Terms without our written consent; we may assign ours in connection with a merger,
          acquisition or sale of assets.
        </p>
        <p>
          These Terms are an agreement between you and {COMPANY.shortName} alone, and not with any
          app store operator. An app store operator has no obligation to provide maintenance or
          support for the applications. If an application fails to conform to any warranty that
          applies to it, you may notify Apple, and Apple will refund the purchase price of that
          application, if any; to the maximum extent permitted by law, Apple has no other warranty
          obligation for it. {COMPANY.shortName} — not the operator — is responsible for addressing
          any claim relating to an application, including product-liability claims, any claim that
          it fails to meet a legal or regulatory requirement, and any claim that it infringes
          someone else’s intellectual property. App store operators and their subsidiaries are
          third-party beneficiaries of these Terms and may enforce them against you.
        </p>
        <p>
          Because we hold no email address for you, we give notice on this website, and you agree
          that notice given that way reaches you. Give us notice at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or at the postal address below.
        </p>
        <p>
          Neither party is liable for a failure to perform caused by something outside its
          reasonable control — a network or provider outage, an act of government, a natural
          disaster — though this does not excuse an obligation to pay for something already bought.
        </p>
        <p>
          You confirm that you are not located in, and are not listed on any restricted-party list
          of, a country subject to an applicable trade embargo.
        </p>
        <p>
          These Terms are the entire agreement between you and {COMPANY.shortName} regarding the
          Service and supersede any earlier agreement or communication about it.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these Terms or your subscription go to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or by post to:
        </p>
        <p className={cn('font-mono text-sm')}>
          {company}
          <br />
          ATTN: {COMPANY.attn}
          <br />
          {COMPANY.addressLines.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
        </p>
      </div>
    </PageShell>
  );
}
