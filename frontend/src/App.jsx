import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home        from './pages/Home'
import SendPage    from './pages/SendPage'
import ReceivePage from './pages/ReceivePage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"        element={<Home />} />
        <Route path="/send"    element={<SendPage />} />
        <Route path="/receive" element={<ReceivePage />} />
      </Routes>
    </BrowserRouter>
  )
}
