import { href } from "../routes";
import { BackIcon } from "./icons";

export function BackLink() {
  return (
    <a className="back-link" href={href.home}>
      <BackIcon />
      All notes
    </a>
  );
}
