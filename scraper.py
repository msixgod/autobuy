import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin


def load_config(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_fetcher(mode: str):
    if mode == "fetch":
        from scrapling.fetchers import Fetcher

        return Fetcher
    if mode == "stealthy":
        from scrapling.fetchers import StealthyFetcher

        return StealthyFetcher
    if mode == "dynamic":
        from scrapling.fetchers import DynamicFetcher

        return DynamicFetcher

    raise ValueError("request.mode must be one of: fetch, stealthy, dynamic")


def fetch_page(url: str, request_cfg: Dict[str, Any]):
    mode = request_cfg.get("mode", "fetch")
    fetcher = build_fetcher(mode)
    adaptive = bool(request_cfg.get("adaptive", False))
    fetcher.adaptive = adaptive

    kwargs: Dict[str, Any] = {
        "timeout": request_cfg.get("timeout", 30000),
        "headers": request_cfg.get("headers", {}),
    }

    impersonate = request_cfg.get("impersonate")
    if impersonate:
        kwargs["impersonate"] = impersonate

    if mode in {"stealthy", "dynamic"}:
        kwargs["headless"] = bool(request_cfg.get("headless", True))
        kwargs["network_idle"] = bool(request_cfg.get("network_idle", True))

    return fetcher.fetch(url, **kwargs)


def extract_value(node: Any, field_cfg: Dict[str, Any]) -> Any:
    selector = field_cfg["selector"]
    value_type = field_cfg.get("type", "text")
    attr_name = field_cfg.get("attr")
    adaptive = bool(field_cfg.get("adaptive", False))

    selected = node.css(selector, adaptive=adaptive)

    if value_type == "list":
        if attr_name:
            return [item.attrib.get(attr_name) for item in selected if item.attrib.get(attr_name) is not None]
        return [item.get() for item in selected]

    if value_type == "attr":
        first = selected.first
        if not first:
            return None
        return first.attrib.get(attr_name)

    return selected.get()


def extract_items(page: Any, config: Dict[str, Any]) -> List[Dict[str, Any]]:
    item_selector = config.get("item_selector")
    fields = config["fields"]

    if item_selector:
        containers = page.css(item_selector)
    else:
        containers = [page]

    items: List[Dict[str, Any]] = []
    for container in containers:
        item: Dict[str, Any] = {}
        for field_name, field_cfg in fields.items():
            item[field_name] = extract_value(container, field_cfg)
        items.append(item)
    return items


def find_next_url(page: Any, config: Dict[str, Any], current_url: str) -> Optional[str]:
    selector = config.get("next_page_selector")
    if not selector:
        return None

    attr_name = config.get("next_page_attr", "href")
    next_link = page.css(selector).first
    if not next_link:
        return None

    href = next_link.attrib.get(attr_name)
    if not href:
        return None

    return urljoin(current_url, href)


def run(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    request_cfg = config.get("request", {})
    max_pages = int(config.get("max_pages", 1))
    all_items: List[Dict[str, Any]] = []

    for start_url in config["start_urls"]:
        current_url = start_url
        visited = set()
        page_count = 0

        while current_url and current_url not in visited and page_count < max_pages:
            visited.add(current_url)
            page = fetch_page(current_url, request_cfg)
            all_items.extend(extract_items(page, config))
            current_url = find_next_url(page, config, current_url)
            page_count += 1

    return all_items


def save_output(items: List[Dict[str, Any]], output_cfg: Dict[str, Any]) -> Path:
    output_path = Path(output_cfg.get("path", "output.json"))
    indent = int(output_cfg.get("indent", 2))
    ensure_ascii = bool(output_cfg.get("ensure_ascii", False))

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(items, handle, indent=indent, ensure_ascii=ensure_ascii)

    return output_path.resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Config-driven Scrapling scraper")
    parser.add_argument(
        "--config",
        default="scraper_config.json",
        help="Path to a JSON config file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config_path = Path(args.config)

    if not config_path.exists():
        raise FileNotFoundError(
            "Config file not found: {}. Copy scraper_config.example.json to scraper_config.json and edit it.".format(
                config_path
            )
        )

    config = load_config(config_path)
    items = run(config)
    output_path = save_output(items, config.get("output", {}))
    print("Scraped {} item(s) to {}".format(len(items), output_path))


if __name__ == "__main__":
    main()
