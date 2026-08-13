import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-3">
          Visual Data Transfer
        </h1>
        <p className="text-gray-400 text-lg">
          Transfer files optically — no internet, no cables required.
        </p>
      </div>

      <nav className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
        <Link
          to="/send"
          id="btn-send"
          className="flex-1 text-center py-4 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-500 font-semibold text-lg transition-colors duration-200"
        >
          Send a File
        </Link>
        <Link
          to="/receive"
          id="btn-receive"
          className="flex-1 text-center py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-lg transition-colors duration-200"
        >
          Receive a File
        </Link>
      </nav>
    </main>
  )
}
