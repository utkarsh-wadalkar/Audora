'use client';

import { FormEvent, useRef, useState } from 'react';
import { Send, Star } from 'lucide-react';
import { submitFeedback } from '../lib/public-data';

const feedbackEmail = 'utkarshwadalkarg6genai@gmail.com';

export function FeedbackForm() {
  const [rating, setRating] = useState(0);
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const submissionToken = useRef<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get('company')) return;
    if (rating < 1) {
      setStatus('error');
      return;
    }

    setStatus('sending');
    submissionToken.current ??= window.crypto.randomUUID();
    const name = String(data.get('name') || '');
    const email = String(data.get('email') || '');
    const role = String(data.get('role') || '');
    const message = String(data.get('message') || '');
    const consentToPublish = data.get('consent') === 'on';

    try {
      await submitFeedback({ submissionToken: submissionToken.current, name, email, role, rating, message, consentToPublish });

      const emailPayload = new FormData();
      emailPayload.set('name', name);
      emailPayload.set('email', email || 'Not provided');
      emailPayload.set('role', role || 'Not provided');
      emailPayload.set('rating', `${rating} / 5`);
      emailPayload.set('feedback', message);
      emailPayload.set('publication consent', consentToPublish ? 'Yes' : 'No');
      emailPayload.set('_subject', `New Audora feedback: ${rating} stars`);
      emailPayload.set('_template', 'table');
      emailPayload.set('_captcha', 'false');

      const emailResponse = await fetch(`https://formsubmit.co/ajax/${feedbackEmail}`, {
        method: 'POST', headers: { Accept: 'application/json' }, body: emailPayload,
      });
      if (!emailResponse.ok) throw new Error('Email delivery failed.');

      form.reset();
      setRating(0);
      submissionToken.current = null;
      setStatus('success');
    } catch {
      setStatus('error');
    }
  }

  return <section id="feedback" className="feedback section container" aria-labelledby="feedback-title">
    <div className="feedback-intro">
      <h2 id="feedback-title">Tell me how<br /><span>Audora feels.</span></h2>
      <p>Your note goes directly to the maker. Reviews appear publicly only when you opt in and after they are checked.</p>
      <div className="feedback-note"><Star size={17} aria-hidden="true" /><span>Honest feedback shapes the next release.</span></div>
    </div>

    <form className="feedback-form" onSubmit={onSubmit}>
      <div className="form-row">
        <label><span>Name</span><input name="name" autoComplete="name" minLength={2} maxLength={80} required /></label>
        <label><span>Email <small>optional</small></span><input name="email" type="email" autoComplete="email" maxLength={254} /></label>
      </div>
      <label><span>Role or company <small>optional</small></span><input name="role" autoComplete="organization-title" maxLength={100} /></label>
      <fieldset className="rating-field">
        <legend>Your rating</legend>
        <div className="rating-options">
          {[1, 2, 3, 4, 5].map(value => <button key={value} type="button" className={value <= rating ? 'selected' : ''}
            onClick={() => { setRating(value); setStatus('idle'); }} aria-label={`${value} star${value === 1 ? '' : 's'}`} aria-pressed={value <= rating}>
            <Star size={26} fill={value <= rating ? 'currentColor' : 'none'} aria-hidden="true" />
          </button>)}
        </div>
        {status === 'error' && rating === 0 && <span className="form-error">Choose a rating from 1 to 5.</span>}
      </fieldset>
      <label><span>Your feedback</span><textarea name="message" minLength={20} maxLength={1200} rows={5} required /><small className="field-help">20-1200 characters</small></label>
      <label className="consent-field"><input name="consent" type="checkbox" /><span>You may publish my name, role, rating, and review on this website.</span></label>
      <label className="honeypot" aria-hidden="true"><span>Company website</span><input name="company" tabIndex={-1} autoComplete="off" /></label>
      <div className="form-submit">
        <button className="button button-primary" type="submit" disabled={status === 'sending'}>
          <Send size={16} aria-hidden="true" />{status === 'sending' ? 'Sending feedback' : 'Send feedback'}
        </button>
        <p className={`form-status ${status}`} aria-live="polite">
          {status === 'success' && 'Thank you. Your feedback has been delivered.'}
          {status === 'error' && rating > 0 && 'Something went wrong. Please try again.'}
        </p>
      </div>
    </form>
  </section>;
}
