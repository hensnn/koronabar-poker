import { useEffect, useState, type FormEvent } from 'react';
import { t } from '@kb/shared';
import { errorText, get, post } from '../api';
import { Link, navigate, queryParam, useLocation } from '../router';
import { login } from '../session';
import { Button, Card, Notice, TextInput } from '../ui';

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="text-center font-heading text-3xl font-bold">{t('app.name')}</h1>
      <Card title={title}>{children}</Card>
    </main>
  );
}

/** Odeslání formuláře s chybou a stavem „pracuji“. */
function useSubmit(run: () => Promise<void>) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await run();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

export function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(async () => {
    await login(identifier, password);
    navigate('/', true);
  });
  return (
    <Page title={t('auth.login.title')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextInput label={t('auth.identifier')} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required autoFocus />
        <TextInput label={t('auth.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        {error && <Notice kind="error">{error}</Notice>}
        <Button variant="primary" type="submit" disabled={busy}>
          {t('auth.login.submit')}
        </Button>
        <div className="flex justify-between text-sm">
          <Link to="/zapomenute-heslo" className="underline">
            {t('auth.forgot.link')}
          </Link>
          <Link to="/registrace" className="underline">
            {t('auth.register.link')}
          </Link>
        </div>
      </form>
    </Page>
  );
}

export function RegisterPage() {
  const { search } = useLocation();
  const [f, setF] = useState({ inviteCode: queryParam(search, 'kod'), nickname: '', email: '', password: '', accept: false });
  const [terms, setTerms] = useState('');
  const [done, setDone] = useState<null | { needsVerification: boolean }>(null);
  useEffect(() => {
    void get<{ text: string }>('/api/public/terms').then((r) => setTerms(r.text)).catch(() => undefined);
  }, []);
  const { error, busy, submit } = useSubmit(async () => {
    const r = await post<{ needsVerification: boolean }>('/api/auth/register', { inviteCode: f.inviteCode, nickname: f.nickname, email: f.email, password: f.password, acceptTerms: f.accept });
    setDone(r);
  });
  if (done) {
    return (
      <Page title={t('auth.register.title')}>
        <Notice kind="success">{done.needsVerification ? t('auth.register.checkEmail') : t('auth.register.done')}</Notice>
        <p className="mt-3">
          <Link to="/prihlaseni" className="underline">
            {t('auth.login.title')}
          </Link>
        </p>
      </Page>
    );
  }
  return (
    <Page title={t('auth.register.title')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <TextInput label={t('auth.inviteCode')} value={f.inviteCode} onChange={(e) => setF({ ...f, inviteCode: e.target.value.toUpperCase() })} required autoFocus />
        <TextInput label={t('auth.nickname')} hint={t('auth.nickname.hint')} value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} autoComplete="username" required />
        <TextInput label={t('auth.email')} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required />
        <TextInput label={t('auth.password')} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        <div className="rounded-md border border-line bg-bg p-3 text-sm">
          <p className="mb-2 font-medium">{t('auth.terms.title')}</p>
          <p>{terms || t('footer.virtualCurrency')}</p>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} required />
          <span>{t('auth.terms.accept')}</span>
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <Button variant="primary" type="submit" disabled={busy}>
          {t('auth.register.submit')}
        </Button>
        <Link to="/prihlaseni" className="text-sm underline">
          {t('auth.login.title')}
        </Link>
      </form>
    </Page>
  );
}

export function ForgotPage() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const { error, busy, submit } = useSubmit(async () => {
    await post('/api/auth/forgot', { identifier });
    setSent(true);
  });
  return (
    <Page title={t('auth.forgot.title')}>
      {sent ? (
        <Notice kind="success">{t('auth.forgot.sent')}</Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextInput label={t('auth.identifier')} value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
          {error && <Notice kind="error">{error}</Notice>}
          <Button variant="primary" type="submit" disabled={busy}>
            {t('auth.forgot.submit')}
          </Button>
        </form>
      )}
      <p className="mt-3">
        <Link to="/prihlaseni" className="underline">
          {t('auth.login.title')}
        </Link>
      </p>
    </Page>
  );
}

export function ResetPage() {
  const { search } = useLocation();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { error, busy, submit } = useSubmit(async () => {
    await post('/api/auth/reset', { token: queryParam(search, 'token'), password });
    setDone(true);
  });
  return (
    <Page title={t('auth.reset.title')}>
      {done ? (
        <Notice kind="success">{t('auth.reset.done')}</Notice>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextInput label={t('auth.newPassword')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required autoFocus />
          {error && <Notice kind="error">{error}</Notice>}
          <Button variant="primary" type="submit" disabled={busy}>
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
      <p className="mt-3">
        <Link to="/prihlaseni" className="underline">
          {t('auth.login.title')}
        </Link>
      </p>
    </Page>
  );
}

/** Stránka pro odkaz z e-mailu: ověření e-mailu nebo potvrzení nového e-mailu. */
export function TokenPage({ kind }: { kind: 'verify' | 'confirm' }) {
  const { search } = useLocation();
  const [state, setState] = useState<'working' | 'ok' | string>('working');
  useEffect(() => {
    const url = kind === 'verify' ? '/api/auth/verify-email' : '/api/auth/confirm-email';
    post(url, { token: queryParam(search, 'token') })
      .then(() => setState('ok'))
      .catch((e) => setState(errorText(e)));
  }, [kind, search]);
  return (
    <Page title={kind === 'verify' ? t('auth.verify.title') : t('auth.confirmEmail.title')}>
      {state === 'working' ? <p role="status">{t('auth.working')}</p> : state === 'ok' ? <Notice kind="success">{kind === 'verify' ? t('auth.verify.done') : t('auth.confirmEmail.done')}</Notice> : <Notice kind="error">{state}</Notice>}
      <p className="mt-3">
        <Link to="/" className="underline">
          {t('nav.home')}
        </Link>
      </p>
    </Page>
  );
}
