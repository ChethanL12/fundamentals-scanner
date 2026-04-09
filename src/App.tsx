import { Switch, Route, Router as WouterRouter } from "wouter";
import FundamentalsPage from "@/pages/fundamentals";

function Router() {
  return (
    <Switch>
      <Route path="/" component={FundamentalsPage} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Router />
    </WouterRouter>
  );
}

export default App;
