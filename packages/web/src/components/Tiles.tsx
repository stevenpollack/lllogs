import React from "react";

interface TilesProps {
  total: string;
  last5: string;
  errorRate: string;
  topTool: string;
}

export function Tiles({ total, last5, errorRate, topTool }: TilesProps): React.ReactElement {
  return (
    <div id="tiles">
      <div className="tile">
        <div className="tile-label">Total events</div>
        <div className="tile-value">{total}</div>
      </div>
      <div className="tile">
        <div className="tile-label">Last 5 min</div>
        <div className="tile-value">{last5}</div>
      </div>
      <div className="tile">
        <div className="tile-label">Error rate</div>
        <div className="tile-value">{errorRate}</div>
      </div>
      <div className="tile">
        <div className="tile-label">Top tool</div>
        <div className="tile-value">{topTool}</div>
      </div>
    </div>
  );
}
