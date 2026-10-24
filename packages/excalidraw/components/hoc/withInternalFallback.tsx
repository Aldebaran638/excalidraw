import React, { useLayoutEffect } from "react";

import { useTunnels } from "../../context/tunnels";
import { atom } from "../../editor-jotai";

export const withInternalFallback = <P,>(
  componentName: string,
  Component: React.FC<P>,
) => {
  const renderAtom = atom(0);

  const WrapperComponent: React.FC<
    P & {
      __fallback?: boolean;
    }
  > = (props) => {
    const {
      tunnelsJotai: { useAtom },
    } = useTunnels();
    // for rerenders
    // This atom is scoped to the editor's tunnel store. A per-instance ref
    // retained the count from THAT instance's mount; when fallback mounted
    // first it kept 1 forever, covering the host with a second empty sidebar.
    const [counter, setCounter] = useAtom(renderAtom);

    useLayoutEffect(() => {
      setCounter((c) => c + 1);
      return () => {
        setCounter((c) => c - 1);
      };
    }, [setCounter]);

    // Layout effects settle the shared count before the next paint.
    if (counter > 1 && props.__fallback) {
      return null;
    }

    return <Component {...props} />;
  };

  WrapperComponent.displayName = componentName;

  return WrapperComponent;
};
